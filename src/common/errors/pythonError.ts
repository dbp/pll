/**
 * An exception, as Python describes it to the host.
 *
 * Built from the fields `_pll_error_info` sends - never parsed out of the
 * traceback text. Python has the exception object and its live frames, so
 * it decides where the error is, which frames are the student's, and what
 * it could learn from them; the host only explains.
 */

export interface ErrorFrame {
  fileName: string;
  /** 1-based. */
  line: number;
  /** 0-based, or null where Python would draw no caret. */
  column: number | null;
  /** Enclosing function, or null for module-level code. */
  functionName: string | null;
  /** Whether this frame runs the student's code, rather than PLL's or a library's. */
  user: boolean;
}

/** What Python learned about the error from the frames it was raised in. */
export interface ErrorFacts {
  /** The name a `NameError` (or `UnboundLocalError`) is about. */
  name?: string;
  /** For an `IndexError`: the sequence subscripted, and its real length. */
  sequence?: string;
  length?: number;
  /** For an element that failed its annotation: what the element was. */
  elementValue?: string;
  /** For a dataclass field of the wrong type: the field whose value fits here. */
  swappedWith?: string;
}

export interface PythonError {
  errorType: string;
  /** As Python's traceback shows it, suggestion included. */
  message: string;
  /** For showing when nothing better can be said; never read. */
  traceback: string;
  /** Where the error is: the innermost frame, or a syntax error's own position. */
  fileName: string | null;
  lineNumber: number | null;
  column: number | null;
  /** For a `NameError`, the unresolved name. */
  nameToken: string | null;
  /** Outermost first. */
  frames: ErrorFrame[];
  facts: ErrorFacts;
}

/** The frames running the student's code, outermost first. */
export function userFrames(error: PythonError): ErrorFrame[] {
  return error.frames.filter((frame) => frame.user);
}

/** The student's own line that failed - or, when a library raised, called it. */
export function innermostUserFrame(error: PythonError): ErrorFrame | null {
  const frames = userFrames(error);
  return frames.length > 0 ? frames[frames.length - 1] : null;
}
