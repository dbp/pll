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

export interface TracebackFrame {
  fileName: string;
  line: number;
  /** Enclosing function, or null for module-level code. */
  functionName: string | null;
}

/**
 * Frames that live outside the user's code, and so should never be shown
 * as "where the error is". `<exec>` is PLL's own bootstrap (it calls
 * `exec` on the student's compiled module); `/pll_vendor` is the bundled
 * type checker.
 */
const NON_USER_FRAME = [
  "<exec>",
  "/pll_vendor",
  "site-packages",
  "/lib/python",
  "_pytest",
  "pluggy",
];

/**
 * The frames in `traceback` belonging to the user's own code, outermost
 * first. The last entry is therefore the line the student wrote that
 * failed, and the one before it is whoever called into it.
 */
export function userTracebackFrames(traceback: string): TracebackFrame[] {
  const frames: TracebackFrame[] = [];
  for (const raw of traceback.split(/\r?\n/)) {
    const m = raw.match(/^\s*File "([^"]+)", line (\d+)(?:, in (\S+))?/);
    if (!m) continue;
    const fileName = m[1];
    if (NON_USER_FRAME.some((token) => fileName.includes(token))) continue;
    frames.push({
      fileName,
      line: parseInt(m[2], 10),
      functionName: m[3] && m[3] !== "<module>" ? m[3] : null,
    });
  }
  return frames;
}

/**
 * The leading whitespace of line `lineNumber` in `source`, or 0.
 *
 * Python's traceback prints `line.strip()`, so the original indentation is
 * gone by the time a caret is placed under it and has to come from the file.
 */
function sourceIndent(source: string | undefined, lineNumber: number): number {
  if (!source) {
    return 0;
  }
  const line = source.split(/\r?\n/)[lineNumber - 1];
  if (line === undefined) {
    return 0;
  }
  return line.length - line.trimStart().length;
}

/**
 * Parse a Python traceback string into a structured error.
 *
 * Pyodide's PythonError exposes the traceback via `error.message` (which is
 * the full formatted traceback ending in "ErrorType: message"). This function
 * is conservative - if it can't find a frame, fields are returned as null.
 */
export function parsePythonError(
  rawTraceback: string,
  /**
   * The file's own text, when the caller has it.
   *
   * Python echoes a source line with its indentation **stripped**, so a
   * caret's position is relative to the trimmed line and a column taken
   * from it lands too far left on anything indented - which is where the
   * editor would then draw the squiggle. Given the source, the real
   * indentation can be added back.
   */
  source?: string,
): ParsedPythonError {
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
        const sourceLine = lines[i];
        const caretIdx = lines[i + 1].indexOf("^");
        if (caretIdx >= 0) {
          // Both lines carry the indent Python adds when it echoes the
          // source, so the caret's index in the *traceback* is further along
          // than its column in the file. Taking it raw put the `NameError`
          // in `print(y)` - eight characters - at column 11.
          const echoed = sourceLine.length - sourceLine.trimStart().length;
          column = Math.max(0, caretIdx - echoed) + sourceIndent(source, lineNumber);
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
