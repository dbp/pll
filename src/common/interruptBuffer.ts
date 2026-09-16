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
 *   Uint8[0]  pending signal number, 0 when none
 *
 * Two limits are inherent to the mechanism, not to this code:
 *   - the check happens between Python bytecodes, so a tight loop inside a C
 *     extension (a long numpy call) will not yield until it returns;
 *   - student code with a bare `except:` around the loop can swallow the
 *     KeyboardInterrupt, exactly as it would in CPython.
 * `ReplSession` reports both cases by noticing the program is still running.
 */

export const INTERRUPT_SAB_BYTES = 1;

/** SIGINT. Pyodide maps this to `KeyboardInterrupt`. */
export const INTERRUPT_SIGINT = 2;

export function tryCreateInterruptBuffer(): SharedArrayBuffer | null {
  try {
    return new SharedArrayBuffer(INTERRUPT_SAB_BYTES);
  } catch {
    return null;
  }
}

/** Request a `KeyboardInterrupt` in the worker. Idempotent. */
export function signalInterrupt(sab: SharedArrayBuffer): void {
  Atomics.store(new Uint8Array(sab), 0, INTERRUPT_SIGINT);
}

/**
 * Drop any signal that was never consumed, so a Stop the interpreter never
 * saw cannot fire into the *next* program the student runs.
 */
export function clearInterrupt(sab: SharedArrayBuffer): void {
  Atomics.store(new Uint8Array(sab), 0, 0);
}
