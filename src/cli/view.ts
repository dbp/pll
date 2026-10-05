import * as fs from "node:fs";
import * as path from "node:path";
import type { SerializedFinding } from "../common/analyzers/findingLocation";
import type { ExamplarEntry } from "../common/examplarPhase";
import type { AnalysisFinding } from "../common/analyzers/types";
import { formatFriendlyError } from "../common/errorFormatter";
import type { ExecutionEvent } from "../common/types";
import { errorText } from "../common/errorText";

/**
 * The CLI's "view": `ExecutionEvent`s as text.
 *
 * Stream discipline matters more here than in the panel, because output
 * gets piped and diffed. The program's own stdout goes to stdout and
 * nothing else does; everything PLL says *about* the run - findings, test
 * results, banners, placeholders - goes to stderr. So `pll hw.py > out.txt`
 * captures exactly what the program printed, which is what an autograder
 * wants.
 */
export interface ViewOptions {
  /** Write images here as .svg instead of printing a placeholder. */
  saveImagesDir?: string;
  /** Suppress PLL's own commentary, keeping only program output. */
  quiet: boolean;
  color: boolean;
}

const ESC = String.fromCharCode(27);

export class CliView {
  private imageCount = 0;

  constructor(private readonly opts: ViewOptions) {}

  private paint(code: string, text: string): string {
    return this.opts.color ? `${ESC}[${code}m${text}${ESC}[0m` : text;
  }

  private dim(text: string): string {
    return this.paint("2", text);
  }

  private red(text: string): string {
    return this.paint("31", text);
  }

  private green(text: string): string {
    return this.paint("32", text);
  }

  private yellow(text: string): string {
    return this.paint("33", text);
  }

  /** PLL's own commentary. Always stderr, silenced by --quiet. */
  note(text: string): void {
    if (!this.opts.quiet) {
      process.stderr.write(text + "\n");
    }
  }

  /** Something the user must see even under --quiet. */
  problem(text: string): void {
    process.stderr.write(text + "\n");
  }

  /** Static-analysis findings, in the same words the editor uses. */
  findings(findings: ReadonlyArray<AnalysisFinding>): void {
    for (const finding of findings) {
      const lines = formatFriendlyError(finding);
      this.problem(this.red(lines[0]));
      for (const line of lines.slice(1)) {
        this.problem(line);
      }
      this.problem("");
    }
  }

  /** A friendly finding for a runtime error, in place of the traceback. */
  runtimeFinding(finding: AnalysisFinding): void {
    const lines = formatFriendlyError(finding);
    this.problem(this.red(lines[0]));
    for (const line of lines.slice(1)) {
      this.problem(line);
    }
  }

  handle(event: ExecutionEvent): void {
    switch (event.kind) {
      case "stdout":
        process.stdout.write(event.text);
        break;
      case "stderr":
        process.stderr.write(event.text);
        break;
      case "result":
        if (event.repr !== null && event.repr !== undefined) {
          process.stdout.write(event.repr + "\n");
        }
        break;
      case "image":
        this.image(event.svg, event.width, event.height);
        break;
      case "table":
        process.stdout.write(renderTable(event) + "\n");
        break;
      case "reactor": {
        // Nothing drives the clock here, so it would never animate. Say so
        // rather than printing a still frame that looks broken.
        // `animate(...)` leaves the title at its default, and
        // `[reactor "reactor" ...]` reads like a mistake.
        const which = event.title === "reactor" ? "reactor" : `reactor "${event.title}"`;
        this.note(
          this.dim(`[${which} needs the editor's interactions panel; not run here]`),
        );
        break;
      }
      case "testReport":
        this.testReport(event);
        break;
      case "error":
        // A run explains every error first, through `runtimeFinding`; this
        // shows one that reached the view unexplained.
        this.problem(this.red(`${event.error.errorType}: ${event.error.message}`));
        break;
      case "done":
        break;
    }
  }

  /**
   * One card of the Examplar verdict: the same lines the panel shows, so a
   * test is named and a buggy implementation is given by its id - nothing
   * more, in either place. Commentary, so on stderr and silenced by --quiet.
   */
  examplarCard(card: ExamplarEntry): void {
    this.note(this.dim("examplar: ") + (card.card === "function" ? card.name : "your tests"));
    const tone = { good: this.green, bad: this.red, warn: this.yellow, note: this.dim };
    for (const block of card.body) {
      if (block.kind === "line") {
        this.note("  " + tone[block.tone].call(this, block.text));
        continue;
      }
      this.note(`    ${block.name}`);
      for (const line of (block.detail ?? "").split("\n")) {
        if (line.trim()) this.note(this.dim(`      ${line}`));
      }
    }
  }

  private image(svg: string, width: number, height: number): void {
    this.imageCount += 1;
    const dir = this.opts.saveImagesDir;
    if (!dir) {
      this.note(
        this.dim(`[image ${width}x${height}; pass --save-images to write it out]`),
      );
      return;
    }
    const target = path.join(dir, `image-${this.imageCount}.svg`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, svg, "utf8");
      this.note(this.dim(`[image ${width}x${height} -> ${target}]`));
    } catch (err) {
      this.problem(`Could not write ${target}: ${errorText(err)}`);
    }
  }

  private testReport(event: Extract<ExecutionEvent, { kind: "testReport" }>): void {
    const bad = event.failed + event.errors;
    const summary =
      `${event.passed} passed` +
      (event.failed ? `, ${event.failed} failed` : "") +
      (event.errors ? `, ${event.errors} errored` : "") +
      (event.skipped ? `, ${event.skipped} skipped` : "") +
      (event.stopped
        ? event.stoppedIn
          ? `, stopped during ${event.stoppedIn}`
          : ", stopped before any test ran"
        : "");
    const label = event.stopped
      ? this.yellow("tests: ")
      : bad === 0
        ? this.green("tests: ")
        : this.red("tests: ");
    this.problem(label + summary);
    for (const test of event.tests) {
      if (test.outcome === "passed") {
        this.note(this.dim(`  ok   ${test.name}`));
        continue;
      }
      if (test.outcome === "stopped") {
        // Where the Stop landed: not a failure, so not red, and with no
        // message - the test did nothing wrong.
        const at = test.lineNumber === null ? "" : ` (line ${test.lineNumber})`;
        this.problem(this.yellow(`  STOPPED ${test.name}${at}`));
        continue;
      }
      const where = test.lineNumber === null ? "" : ` (line ${test.lineNumber})`;
      this.problem(this.red(`  ${test.outcome.toUpperCase()} ${test.name}${where}`));
      const body = test.finding ? findingLines(test.finding) : (test.message ?? "").split("\n");
      for (const line of body) {
        if (line.trim()) {
          this.problem("        " + line);
        }
      }
      // What the test printed before it failed. The editor's card shows
      // this, and a `print` put there to see what a function returned is
      // the first debugging tool a beginner is taught - so leaving it out
      // here quietly broke that lesson on the command line.
      const printed = (test.stdout ?? "").replace(/\s+$/, "");
      if (printed) {
        this.problem(this.dim("        output:"));
        for (const line of printed.split("\n")) {
          this.problem(this.dim("          " + line));
        }
      }
    }
  }
}

/** A test's finding, compactly: the headline, where, and what to do. */
function findingLines(finding: SerializedFinding): string[] {
  return [
    `${finding.errorType}: ${finding.headline}`,
    ...(finding.location ? [`at ${finding.location.label}`] : []),
    ...finding.howToFix.map((line) => `- ${line}`),
  ];
}

/**
 * A table as fixed-width text.
 *
 * Tables are deliberately *not* a no-op like images: their content is
 * already text, and the Python side has pre-formatted every cell, so the
 * terminal can show the same thing the panel shows.
 */
export function renderTable(table: {
  columns: string[];
  rows: string[][];
  rowCount: number;
  shownCount: number;
  truncated: boolean;
}): string {
  const widths = table.columns.map((name, i) =>
    Math.max(name.length, ...table.rows.map((row) => (row[i] ?? "").length), 0),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  const out = [
    line(table.columns),
    widths
      .map((w) => "-".repeat(w))
      .join("  ")
      .trimEnd(),
  ];
  for (const row of table.rows) {
    out.push(line(table.columns.map((_, i) => row[i] ?? "")));
  }
  out.push(
    table.truncated
      ? `(${table.shownCount} of ${table.rowCount} rows)`
      : `(${table.rowCount} row${table.rowCount === 1 ? "" : "s"})`,
  );
  return out.join("\n");
}
