import type { StaticFinding } from "../fromPython";
import type { Level } from "../level";

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
  /** The student's line, as written, for a frame of theirs. */
  text: string | null;
  /** The parameters of their function, for a frame of theirs in one. */
  parameters: string[] | null;
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
  /** Its type's name, as the course calls it. */
  elementType?: string;
  /** For a dataclass field of the wrong type: the field whose value fits here. */
  swappedWith?: string;
  /** For a `TypeCheckError`: what failed its annotation. */
  check?: TypeCheck;
  /**
   * What the names in the message and on the failing line are, wherever
   * they were defined: `shapes.area`, and `area` as a message names it.
   */
  definitions?: Record<string, Definition>;
  /** Where each name on the failing line was last set from a call. */
  assigned?: Record<string, { call: string; line: number }>;
  /** For a function annotated to return something that returned `None`: how it is built. */
  returnedNone?: ReturnedNone;
  /** For a `KeyboardInterrupt`: whether a Stop raised it, rather than the program. */
  stop?: boolean;
  /**
   * For `ChecksFailed`: the student's file that was not imported, its level,
   * and what that level's checks found - its static errors, or a broken
   * `#level` line.
   */
  checks?: {
    file: string;
    level: Level;
    findings: StaticFinding[];
    headerProblem: { line: number; message: string } | null;
  };
  /**
   * For a `ModuleNotFoundError`, why: Pyodide has no such package and it is
   * none of the student's files (`missing`, with one it may misspell);
   * their file was kept back (`leftOut`); Pyodide has it and it did not
   * load (`notLoaded`); or no import PLL read before the run named it
   * (`notSeen`).
   */
  module?: {
    name: string;
    kind: "missing" | "leftOut" | "notLoaded" | "notSeen";
    close: string | null;
    why: string | null;
    package: string | null;
  };
}

/**
 * What a name in the error is: a function - its positional parameters, and
 * those with no default, a method's `self` left out - a class, whose
 * `fields` are listed only when it is one of the student's, or a union.
 */
export type Definition =
  | { kind: "function"; parameters: string[]; required: string[] }
  | { kind: "class"; students: boolean; fields: string[]; dataclass: boolean }
  | { kind: "union"; members: string[] };

export interface ReturnedNone {
  /** The `match` the function ends with, if it does. */
  match: TrailingMatch | null;
  /** The first `print` that ends a branch: its line, and its one argument. */
  printed: { line: number; expression: string | null } | null;
}

/** A `match` that ends a function, which returns `None` when no `case` fits. */
export interface TrailingMatch {
  /** What is matched, as written. */
  subject: string;
  /** Each `case` pattern, as written. */
  patterns: string[];
  /** The list patterns of a fixed length of 2 or more, like `[f, r]`. */
  fixedLength: string[];
  /** Whether any `case` matches a list. */
  hasList: boolean;
  /** The members of a union-annotated subject that no `case` names. */
  uncovered: string[];
}

/** What failed its annotation: typeguard's message, read into its parts. */
export interface TypeCheck {
  /** What the annotation is on; "unknown" when the wording is unfamiliar. */
  kind: "argument" | "return" | "variable" | "field" | "unknown";
  /** Parameter, variable or field name, when there is one. */
  name: string | null;
  /** typeguard's words for the part of a collection that failed: "item 2". */
  element: string | null;
  /** The type the value had, as typeguard names it. */
  actual: string | null;
  /** The types the annotation accepts. */
  expected: string[];
  /** For "field": the class whose field it is, and the value it got. */
  owner?: string;
  value?: string;
  /** The level of the code whose annotation it is, which may not be the run's. */
  level?: Level;
  /** For "return": the function's return annotation, as written. */
  annotation?: string | null;
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
  /** The text of that line, when it is the student's. */
  text: string | null;
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
