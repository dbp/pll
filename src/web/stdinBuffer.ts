/**
 * SharedArrayBuffer protocol for blocking `input()` in the web worker.
 *
 * Layout (little-endian):
 *   Int32[0]  state: WAITING | LINE | EOF
 *   Int32[1]  UTF-8 byte length of the payload
 *   bytes[8…] UTF-8 text of the line (no trailing newline)
 *
 * The worker stores WAITING, posts `stdinRequest`, then `Atomics.wait`s.
 * The extension host writes the line (or EOF) and `Atomics.notify`s.
 * This has to be a SAB: the worker is blocked, so it cannot receive the
 * line via `postMessage`.
 */

export const STDIN_SAB_BYTES = 64 * 1024;
export const STDIN_STATE_INDEX = 0;
export const STDIN_LENGTH_INDEX = 1;
export const STDIN_PAYLOAD_OFFSET = 8;

export const STDIN_STATE_WAITING = 0;
export const STDIN_STATE_LINE = 1;
export const STDIN_STATE_EOF = 2;

export function tryCreateStdinBuffer(): SharedArrayBuffer | null {
  try {
    return new SharedArrayBuffer(STDIN_SAB_BYTES);
  } catch {
    return null;
  }
}

function decodeSharedBytes(sab: SharedArrayBuffer, offset: number, length: number): string {
  // TextDecoder.decode() throws on a SharedArrayBuffer view in browsers
  // (TypeError: "The provided ArrayBufferView value must not be shared"),
  // which Pyodide turns into OSError errno 29. Copy into an unshared buffer.
  const copy = new Uint8Array(length);
  if (length > 0) {
    copy.set(new Uint8Array(sab, offset, length));
  }
  return new TextDecoder().decode(copy);
}

/** Called on the worker thread. `requestInput` posts `stdinRequest` to the host. */
export function waitForStdinLine(
  sab: SharedArrayBuffer,
  requestInput: () => void,
): string | null {
  const state = new Int32Array(sab);
  Atomics.store(state, STDIN_STATE_INDEX, STDIN_STATE_WAITING);
  requestInput();
  Atomics.wait(state, STDIN_STATE_INDEX, STDIN_STATE_WAITING);
  const next = Atomics.load(state, STDIN_STATE_INDEX);
  if (next === STDIN_STATE_EOF) {
    return null;
  }
  const n = Atomics.load(state, STDIN_LENGTH_INDEX);
  const max = sab.byteLength - STDIN_PAYLOAD_OFFSET;
  const len = n > 0 && n <= max ? n : 0;
  return decodeSharedBytes(sab, STDIN_PAYLOAD_OFFSET, len);
}

/** Called on the extension-host thread after the user submits a line. */
export function writeStdinLine(sab: SharedArrayBuffer, line: string | null): void {
  const state = new Int32Array(sab);
  if (line === null) {
    Atomics.store(state, STDIN_STATE_INDEX, STDIN_STATE_EOF);
    Atomics.notify(state, STDIN_STATE_INDEX);
    return;
  }
  const encoded = new TextEncoder().encode(line);
  const max = sab.byteLength - STDIN_PAYLOAD_OFFSET;
  const n = Math.min(encoded.length, max);
  const bytes = new Uint8Array(sab, STDIN_PAYLOAD_OFFSET);
  bytes.set(encoded.subarray(0, n));
  Atomics.store(state, STDIN_LENGTH_INDEX, n);
  Atomics.store(state, STDIN_STATE_INDEX, STDIN_STATE_LINE);
  Atomics.notify(state, STDIN_STATE_INDEX);
}
