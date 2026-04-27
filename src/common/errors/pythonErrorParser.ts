export interface ParsedPythonError {
  errorType: string;
  message: string;
  traceback: string;
  fileName: string | null;
  lineNumber: number | null;
  column: number | null;
  /** For NameError this is the unresolved name. */
  nameToken: string | null;
}

/**
 * Parse a Python traceback string into a structured error.
 *
 * Pyodide's PythonError exposes the traceback via `error.message` (which is
 * the full formatted traceback ending in "ErrorType: message"). This function
 * is conservative - if it can't find a frame, fields are returned as null.
 */
export function parsePythonError(rawTraceback: string): ParsedPythonError {
  const traceback = rawTraceback.trimEnd();
  const lines = traceback.split(/\r?\n/);

  let errorType = "Error";
  let message = traceback;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_.]*):\s?(.*)$/);
    if (m && !line.startsWith(" ")) {
      errorType = m[1];
      message = m[2];
      break;
    }
    if (line.match(/^[A-Za-z_][A-Za-z0-9_.]*$/) && !line.startsWith(" ")) {
      errorType = line;
      message = "";
      break;
    }
  }

  let fileName: string | null = null;
  let lineNumber: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/^\s*File\s+"([^"]+)",\s+line\s+(\d+)/);
    if (m) {
      fileName = m[1];
      lineNumber = parseInt(m[2], 10);
      break;
    }
  }

  let column: number | null = null;
  if (lineNumber !== null) {
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\s*\^+\s*$/.test(lines[i + 1] ?? "")) {
        const caretLine = lines[i + 1];
        const caretIdx = caretLine.indexOf("^");
        if (caretIdx >= 0) {
          column = caretIdx;
        }
      }
    }
  }

  let nameToken: string | null = null;
  if (errorType === "NameError") {
    const nm = message.match(/name '([^']+)' is not defined/);
    if (nm) {
      nameToken = nm[1];
    }
  }

  return {
    errorType,
    message,
    traceback,
    fileName,
    lineNumber,
    column,
    nameToken,
  };
}
