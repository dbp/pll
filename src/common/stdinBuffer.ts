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
 * This has to be a SAB: the worker is blocked, so it cannot receive the
 * bytes via `postMessage`.
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
