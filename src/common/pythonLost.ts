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
