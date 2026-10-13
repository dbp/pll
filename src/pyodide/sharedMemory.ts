/**
 * The two SharedArrayBuffers between the host and the worker: stdin, for a
 * program reading it, and Stop. Both have to be shared memory because the
 * worker is blocked - waiting for stdin, or inside a synchronous
 * `runPython` - and will not read a `postMessage` until that returns.
 */

/**
 * SharedArrayBuffer protocol for a program reading stdin - `input()`,
 * `sys.stdin.read()`.
 *
 * Layout (little-endian):
 *   Int32[0]  state: WAITING | DATA | EOF | INTERRUPTED
 *   Int32[1]  byte length of the payload
 *   Int32[2]  which request this is, counted by the worker
 *   bytes[16…] the payload: the next bytes of stdin, exactly as given
 *
 * The worker stores WAITING with the next request number, posts
 * `stdinRequest`, then `Atomics.wait`s. The host writes the next bytes (or
 * EOF) for that request and `Atomics.notify`s; a Stop writes INTERRUPTED.
 *
 * Stdin is a stream, not lines: the editor gives each line typed with its
 * newline, the command line whatever its stdin holds. A chunk too big for
 * the buffer is given over several requests.
 */

export const STDIN_SAB_BYTES = 64 * 1024;
export const STDIN_STATE_INDEX = 0;
export const STDIN_LENGTH_INDEX = 1;
export const STDIN_REQUEST_INDEX = 2;
export const STDIN_PAYLOAD_OFFSET = 16;

export const STDIN_STATE_WAITING = 0;
export const STDIN_STATE_DATA = 1;
export const STDIN_STATE_EOF = 2;
export const STDIN_STATE_INTERRUPTED = 3;

export function tryCreateStdinBuffer(): SharedArrayBuffer | null {
  try {
    return new SharedArrayBuffer(STDIN_SAB_BYTES);
  } catch {
    return null;
  }
}

/**
 * Called on the worker thread: wait for the next bytes of stdin. Null is
 * EOF; "interrupted" is a Stop pressed while it waited. `requestInput`
 * posts `stdinRequest` with the request's number.
 */
export function waitForStdin(
  sab: SharedArrayBuffer,
  requestInput: (request: number) => void,
): Uint8Array | null | "interrupted" {
  const state = new Int32Array(sab);
  const request = Atomics.load(state, STDIN_REQUEST_INDEX) + 1;
  Atomics.store(state, STDIN_REQUEST_INDEX, request);
  Atomics.store(state, STDIN_STATE_INDEX, STDIN_STATE_WAITING);
  requestInput(request);
  Atomics.wait(state, STDIN_STATE_INDEX, STDIN_STATE_WAITING);
  const next = Atomics.load(state, STDIN_STATE_INDEX);
  if (next === STDIN_STATE_EOF) {
    return null;
  }
  if (next === STDIN_STATE_INTERRUPTED) {
    return "interrupted";
  }
  const n = Atomics.load(state, STDIN_LENGTH_INDEX);
  const max = sab.byteLength - STDIN_PAYLOAD_OFFSET;
  const length = n > 0 && n <= max ? n : 0;
  // Copied out of shared memory: `TextDecoder` refuses a shared view in
  // browsers, and the next request reuses the buffer.
  const copy = new Uint8Array(length);
  copy.set(new Uint8Array(sab, STDIN_PAYLOAD_OFFSET, length));
  return copy;
}

/**
 * Called on the host: answer `request` with the next bytes of stdin, or
 * EOF. Returns how many of `bytes` were given - the rest are for the next
 * request - or -1 when the worker is no longer waiting for this one (a
 * Stop ended the wait).
 */
export function writeStdin(sab: SharedArrayBuffer, request: number, bytes: Uint8Array | null): number {
  const state = new Int32Array(sab);
  if (
    Atomics.load(state, STDIN_REQUEST_INDEX) !== request ||
    Atomics.load(state, STDIN_STATE_INDEX) !== STDIN_STATE_WAITING
  ) {
    return -1;
  }
  let n = 0;
  if (bytes !== null) {
    // The worker reads none of this until the state moves on from WAITING.
    n = Math.min(bytes.length, sab.byteLength - STDIN_PAYLOAD_OFFSET);
    new Uint8Array(sab, STDIN_PAYLOAD_OFFSET).set(bytes.subarray(0, n));
    Atomics.store(state, STDIN_LENGTH_INDEX, n);
  }
  // Exchanged, not stored: a Stop may have ended the wait meanwhile.
  const answer = bytes === null ? STDIN_STATE_EOF : STDIN_STATE_DATA;
  const was = Atomics.compareExchange(state, STDIN_STATE_INDEX, STDIN_STATE_WAITING, answer);
  if (was !== STDIN_STATE_WAITING) {
    return -1;
  }
  Atomics.notify(state, STDIN_STATE_INDEX);
  return n;
}

/** Called on the host by a Stop: end a wait for stdin, if there is one. */
export function interruptStdin(sab: SharedArrayBuffer): void {
  const state = new Int32Array(sab);
  if (
    Atomics.compareExchange(state, STDIN_STATE_INDEX, STDIN_STATE_WAITING, STDIN_STATE_INTERRUPTED) ===
    STDIN_STATE_WAITING
  ) {
    Atomics.notify(state, STDIN_STATE_INDEX);
  }
}

/**
 * SharedArrayBuffer used to stop a running program.
 *
 * Pyodide polls this buffer while executing Python: writing SIGINT (2) makes
 * the interpreter raise `KeyboardInterrupt` at its next bytecode check.
 *
 * Layout:
 *   Uint8[0]  pending signal number, 0 when none - Pyodide's
 *   Uint8[1]  1 once Python has delivered the current Stop - PLL's
 *
 * Why the second byte. Pyodide's check reads byte 0 and then writes 0 to it
 * unconditionally, as two separate steps:
 *
 *   let result = buffer[0];
 *   buffer[0] = 0;
 *
 * A Stop stored between the two is overwritten without ever being read, and
 * the program keeps running. The interpreter checks thousands of times a
 * second, so this lost roughly one Stop in twenty to forty. A single store
 * cannot be made safe against that from outside Pyodide, so a Stop is
 * re-asserted until Python acknowledges it: PLL's SIGINT handler sets byte 1
 * as it raises `KeyboardInterrupt`, and ignores any repeat that arrives
 * after that, so a re-assert landing during PLL's own clean-up after the
 * interrupt is consumed rather than raised a second time.
 *
 * Two limits are inherent to the mechanism, not to this code:
 *   - the check happens between Python bytecodes, so a tight loop inside a C
 *     extension (a long numpy call) will not yield until it returns;
 *   - student code with a bare `except:` around the loop can swallow the
 *     KeyboardInterrupt, exactly as it would in CPython.
 * `ReplSession` reports both cases by noticing the program is still running.
 */

export const INTERRUPT_SAB_BYTES = 2;

/** SIGINT. Pyodide maps this to `KeyboardInterrupt`. */
export const INTERRUPT_SIGINT = 2;

/** Byte Python sets when it has delivered the current Stop. */
export const INTERRUPT_ACK_INDEX = 1;

/** How often an unacknowledged Stop is asserted again. */
export const INTERRUPT_RETRY_MS = 15;

/**
 * Longest a Stop is re-asserted for. Only a safety net: a Stop is
 * acknowledged within one retry, and one that is not is up against a loop
 * inside C code (a long numpy call), which no signal can break into.
 */
export const INTERRUPT_RETRY_LIMIT_MS = 10000;

export function tryCreateInterruptBuffer(): SharedArrayBuffer | null {
  try {
    return new SharedArrayBuffer(INTERRUPT_SAB_BYTES);
  } catch {
    return null;
  }
}

/**
 * Ask for a `KeyboardInterrupt`, and keep asking until Python has it.
 *
 * `stillRunning` says whether the work that was running when Stop was
 * pressed is still going. The retries stop when it is not, so a Stop can
 * never carry over into the next program - and with nothing running, the
 * signal is stored once and left for the next run to clear.
 */
export function requestInterrupt(
  sab: SharedArrayBuffer,
  stillRunning: () => boolean,
  retryMs = INTERRUPT_RETRY_MS,
  limitMs = INTERRUPT_RETRY_LIMIT_MS,
): void {
  const view = new Uint8Array(sab);
  // A fresh Stop: whatever an earlier one was acknowledged as, this one
  // has not been delivered yet. This is also what lets a second press
  // interrupt a program that caught the first `KeyboardInterrupt`.
  if (view.length > INTERRUPT_ACK_INDEX) {
    Atomics.store(view, INTERRUPT_ACK_INDEX, 0);
  }
  Atomics.store(view, 0, INTERRUPT_SIGINT);
  if (view.length <= INTERRUPT_ACK_INDEX) {
    return;
  }
  const deadline = Date.now() + limitMs;
  const retry = () => {
    if (
      Atomics.load(view, INTERRUPT_ACK_INDEX) !== 0 ||
      !stillRunning() ||
      Date.now() > deadline
    ) {
      return;
    }
    // Only re-store a signal that has been taken and not delivered: one
    // still sitting there has simply not been read yet.
    if (Atomics.load(view, 0) === 0) {
      Atomics.store(view, 0, INTERRUPT_SIGINT);
    }
    setTimeout(retry, retryMs);
  };
  setTimeout(retry, retryMs);
}

/**
 * Drop any signal that was never consumed, so a Stop the interpreter never
 * saw cannot fire into the *next* program the student runs.
 */
export function clearInterrupt(sab: SharedArrayBuffer): void {
  // Byte 0 only. The acknowledgement belongs to the host's current Stop,
  // and clearing it here could restart retries into the next program.
  Atomics.store(new Uint8Array(sab), 0, 0);
}

/**
 * Wait up to `seconds`, or until a Stop is pressed: true if one was. For
 * `time.sleep`, which otherwise runs no bytecode for Pyodide to see a Stop
 * between. Waits in short slices, since the host does not wake this thread
 * when it stores a Stop.
 */
export function waitForStop(view: Uint8Array): (seconds: number) => boolean {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  return (seconds) => {
    const end = Date.now() + seconds * 1000;
    for (;;) {
      if (view[0] === INTERRUPT_SIGINT) return true;
      const left = end - Date.now();
      if (left <= 0) return false;
      Atomics.wait(cell, 0, 0, Math.min(left, 20));
    }
  };
}
