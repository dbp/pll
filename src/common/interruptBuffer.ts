/**
 * SharedArrayBuffer used to stop a running program.
 *
 * Pyodide polls this buffer while executing Python: writing SIGINT (2) makes
 * the interpreter raise `KeyboardInterrupt` at its next bytecode check. It
 * has to be shared memory for the same reason stdin does - the worker is
 * inside a synchronous `runPython` and will not read a `postMessage` until
 * that call returns, which is exactly what we are trying to escape.
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

/** Store the signal once. Idempotent, and on its own not reliable - see above. */
export function signalInterrupt(sab: SharedArrayBuffer): void {
  Atomics.store(new Uint8Array(sab), 0, INTERRUPT_SIGINT);
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
