import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runFilePlan, type RunHost, type RunSummary } from "../common/runPlan";
import type { PythonRuntime } from "../common/types";
import { createFileStore } from "./bundleStore";
import { collectSiblingFiles, writeBackSiblingFiles } from "./files";
import type { CliView } from "./view";
import { errorText } from "../common/errorText";

/**
 * Exit codes. Distinct on purpose: an autograder wants to tell "the level
 * rejected this file" from "the tests failed" from "it crashed".
 */
export const EXIT = {
  ok: 0,
  /** The program raised, or Ctrl+C stopped the run. */
  programError: 1,
  /** Level checks found problems, so the file was not run. */
  blocked: 2,
  /** The program ran, but its in-file tests did not all pass. */
  testsFailed: 3,
  /** Bad usage, or PLL itself could not run. */
  usage: 64,
} as const;

export interface RunOptions {
  /** Path to the .py file. */
  file: string;
  /** Run in-file `test_*` functions before the file, as the editor does. */
  runTests: boolean;
  /**
   * Whether Ctrl+C has been pressed. Checked before each phase: a Stop
   * pressed while one phase is starting up, or between two, reaches no
   * running Python, and the next phase clears it as it starts, so this is
   * the only place it is seen.
   */
  stopRequested?: () => boolean;
}

/**
 * Run one file, the way the editor does: `runFilePlan` holds the steps, and
 * this says how a terminal shows them. The program's own output is the only
 * thing on stdout; everything PLL says about the run goes to stderr.
 */
export async function runFile(
  runtime: PythonRuntime,
  view: CliView,
  opts: RunOptions,
): Promise<number> {
  const fileName = path.basename(opts.file);
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(opts.file);
  } catch (err) {
    view.problem(`pll: ${cannotRead(opts.file, err)}`);
    return EXIT.usage;
  }
  const decoded = decodeSource(bytes, fileName);
  if ("problem" in decoded) {
    view.problem(decoded.problem);
    return EXIT.programError;
  }
  const source = decoded.text;

  // Started here, before anything is checked, so that a Python that cannot
  // start is said once - not once for each step that needs it - and a
  // Ctrl+C while it loads need not wait for it.
  const start = await startPython(runtime, opts.stopRequested ?? (() => false));
  if (start === "stopped") {
    view.problem("Stopped before the program started. Nothing was run.");
    return EXIT.programError;
  }
  if (start !== "started") {
    view.problem(`pll: Python could not start: ${start.problem}`);
    return EXIT.usage;
  }

  const host: RunHost = {
    level: (level) => view.note(`${fileName} [${level}]`),
    staticFindings: (findings) => view.findings(findings),
    runtimeFinding: (finding) => view.runtimeFinding(finding),
    event: (event) => view.handle(event),
    say: (text, kind) => (kind === "problem" ? view.problem(text) : view.note(text)),
    status: () => undefined,
    stopRequested: opts.stopRequested ?? (() => false),
    siblingFiles: () => collectSiblingFiles(opts.file),
    writeBack: (changes, loaded) => writeBackSiblingFiles(opts.file, changes, loaded),
    examplarCard: (card) => view.examplarCard(card),
  };
  const summary = await runFilePlan(runtime, host, {
    code: source,
    fileName,
    sessionKey: opts.file,
    runTests: opts.runTests,
    testsOfIncompleteFile: true,
    bundles: createFileStore(),
  });
  return exitCodeOf(summary);
}

/**
 * The exit code for how a run went. The program's own status is passed on
 * as `python` would exit with it; one other than 0 outranks a failed test,
 * which the report has already listed.
 */
export function exitCodeOf(summary: RunSummary): number {
  if (summary.outcome === "blocked") return EXIT.blocked;
  if (summary.outcome === "stopped" || summary.raised) return EXIT.programError;
  if (summary.exitCode !== null && processStatus(summary.exitCode) !== 0) {
    return processStatus(summary.exitCode);
  }
  if (summary.testFailures > 0) return EXIT.testsFailed;
  return EXIT.ok;
}

/**
 * A status as the shell sees it: the low byte, which is what an exit status
 * is on POSIX. `sys.exit(256)` exits 0 under CPython too; one too large to
 * be a status at all is a failure.
 */
function processStatus(code: number): number {
  if (!Number.isSafeInteger(code)) return EXIT.programError;
  return ((code % 256) + 256) % 256;
}

/** Start Python, or see a Ctrl+C first. */
async function startPython(
  runtime: PythonRuntime,
  stopRequested: () => boolean,
): Promise<"started" | "stopped" | { problem: string }> {
  let watch: ReturnType<typeof setInterval> | undefined;
  const stop = new Promise<"stopped">((resolve) => {
    watch = setInterval(() => stopRequested() && resolve("stopped"), 50);
  });
  try {
    return await Promise.race([
      runtime.initialize().then(
        () => "started" as const,
        (err: unknown) => ({ problem: errorText(err) }),
      ),
      stop,
    ]);
  } finally {
    clearInterval(watch);
  }
}

/** A `# -*- coding: latin-1 -*-` line, as PEP 263 reads one. */
const CODING_RE = /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/;

/**
 * A source file's text, as Python reads one: UTF-8, with a byte-order mark
 * dropped - or the encoding a coding line in its first two lines names. A
 * file that is neither is refused, as `python` refuses it.
 */
export function decodeSource(bytes: Uint8Array, fileName: string): { text: string } | { problem: string } {
  try {
    // The decoder drops a byte-order mark, as Python does.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    /* not UTF-8: a coding line may say what it is */
  }
  const head = Array.from(bytes.subarray(0, 400), (b) => String.fromCharCode(b)).join("");
  const [first = "", second = ""] = head.split(/\r?\n/);
  const cookie = CODING_RE.exec(first) ?? (/^[ \t\f]*(#.*)?$/.test(first) ? CODING_RE.exec(second) : null);
  const encoding = cookie?.[1].toLowerCase().replace(/_/g, "-");
  if (encoding === "latin-1" || encoding === "iso-8859-1" || encoding === "latin1") {
    // Exactly Latin-1: `TextDecoder` reads that label as windows-1252.
    return { text: Array.from(bytes, (b) => String.fromCharCode(b)).join("") };
  }
  if (encoding !== undefined) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes) };
    } catch {
      const named = cookie?.[1];
      return { problem: `SyntaxError: ${fileName} says it is in ${named}, but cannot be read as that.` };
    }
  }
  const at = firstInvalidUtf8(bytes);
  const byte = bytes[at.index].toString(16);
  return {
    problem:
      `SyntaxError: ${fileName} is not saved as UTF-8 (byte 0x${byte} on line ${at.line}). ` +
      "Save it as UTF-8, or declare its encoding on its first line: `# -*- coding: latin-1 -*-`.",
  };
}

/** Where UTF-8 decoding of `bytes` fails: the byte, and its line. */
function firstInvalidUtf8(bytes: Uint8Array): { index: number; line: number } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let low = 0;
  let high = bytes.length;
  // The longest prefix that decodes, give or take a sequence cut in two.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    try {
      decoder.decode(bytes.subarray(0, mid));
      low = mid;
    } catch {
      high = mid - 1;
    }
  }
  let index = Math.min(low, bytes.length - 1);
  while (index < bytes.length - 1 && bytes[index] < 0x80) index++;
  let line = 1;
  for (let i = 0; i < index; i++) if (bytes[i] === 0x0a) line++;
  return { index, line };
}

/** Why the file named on the command line cannot be run, in a sentence. */
function cannotRead(file: string, err: unknown): string {
  const shown = path.relative(process.cwd(), file) || file;
  switch ((err as { code?: unknown }).code) {
    case "ENOENT":
      return `cannot open ${shown}: there is no such file`;
    case "EISDIR":
      return `${shown} is a folder, not a file`;
    case "EACCES":
    case "EPERM":
      return `cannot open ${shown}: permission denied`;
    default:
      return `cannot open ${shown}: ${errorText(err)}`;
  }
}
