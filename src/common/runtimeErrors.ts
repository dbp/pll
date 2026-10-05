/**
 * The two ways a request to Python fails that the host acts on, rather than
 * only reports. Any other failure is a plain `Error`.
 */

/**
 * Python is gone: its worker stopped, or the interpreter inside can no
 * longer run (after a fatal error Pyodide refuses every later call). The
 * request that was waiting fails with this, and the next one starts a new
 * Python - in which every session starts empty.
 */
export class PythonLostError extends Error {
  constructor() {
    super("Python stopped completely.");
    this.name = "PythonLostError";
  }
}

/** A Stop ended the request, in Python (`KeyboardInterrupt`). */
export class StoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoppedError";
  }
}
