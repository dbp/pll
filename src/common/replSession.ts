import * as vscode from "vscode";
import { findRuntimeFinding } from "./analyzers/registry";
import { enrichStaticFindings } from "./analyzers/static/registry";
import type { BonnieDiagnostics } from "./diagnostics";
import { parsePythonError } from "./errors/pythonErrorParser";
import type { BonnieInteractionsView } from "./interactionsView";
import { parseLevel, type Level } from "./level";
import type { ExecutionEvent, PythonRuntime } from "./types";

export interface BonnieReplDeps {
  runtime: PythonRuntime;
  diagnostics: BonnieDiagnostics;
  view: BonnieInteractionsView;
}

/**
 * Drives the Bonnie interactions view: serves as the bridge between user
 * input/file runs and the Pyodide runtime. There is no terminal anymore;
 * everything happens in BonnieInteractionsView.
 *
 * Responsibilities:
 *   - One-shot Python initialization (kicked off eagerly so the UI is
 *     usable as soon as the user looks at it).
 *   - File runs: clear stream, parse the language level, gate beginner files
 *     on static checks, stream the resulting events as Entries.
 *   - REPL input: accept submissions from the webview, handle multi-line
 *     buffering via codeop.compile_command, run on the same shared globals
 *     so file-level definitions persist into REPL evaluations.
 *   - Stream batching: buffer stdout/stderr by `\n` so partial-line writes
 *     (e.g. `print(end="")`) coalesce into single Entries instead of
 *     creating one block per chunk.
 */
export class BonnieReplSession implements vscode.Disposable {
  private execChain: Promise<void> = Promise.resolve();

  private initialized = false;
  private initPromise: Promise<boolean> | null = null;

  // Multi-line REPL buffer.
  private continuationLines: string[] = [];
  private continuing = false;

  // Line-buffered stream output.
  private stdoutBuf = "";
  private stderrBuf = "";

  constructor(private readonly deps: BonnieReplDeps) {
    deps.view.setHandlers({
      onSubmit: (code) => this.handleSubmit(code),
      onInterrupt: () => this.handleInterrupt(),
      onClearRequested: () => this.handleClearRequested(),
    });
    void this.ensureInitialized();
  }

  /** Reveal the interactions view (creates it on first call). */
  show(preserveFocus = false): void {
    void this.deps.view.reveal({ preserveFocus });
  }

  /** Run a file in the same globals used by the REPL. */
  async runFile(
    code: string,
    fileName: string,
    document?: vscode.TextDocument,
  ): Promise<void> {
    this.show(false);
    return this.enqueue(() => this.executeFile(code, fileName, document));
  }

  dispose(): void {
    /* Subscriptions owned externally; nothing to clean up here. */
  }

  /* -------- Init -------- */

  private async ensureInitialized(): Promise<boolean> {
    if (this.initPromise) return this.initPromise;
    this.deps.view.appendBanner("Bonnie Python");
    this.deps.view.appendBanner("Loading Python...");
    this.deps.view.setBusy(true, "Loading...");
    this.initPromise = (async () => {
      try {
        await this.deps.runtime.initialize();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.view.appendRawError("InitializationError", msg, "");
        this.deps.view.setBusy(false);
        return false;
      }
      this.initialized = true;
      this.deps.view.appendBanner(
        "Ready. \u2191/\u2193: history. Shift+Enter: newline. Ctrl/Cmd+L: clear.",
      );
      this.deps.view.setBusy(false);
      this.deps.view.setPrompt("primary");
      return true;
    })();
    return this.initPromise;
  }

  /* -------- Handlers from the view -------- */

  private handleSubmit(code: string): void {
    void this.processSubmission(code);
  }

  private handleInterrupt(): void {
    if (this.continuing) {
      this.continuationLines = [];
      this.continuing = false;
      this.deps.view.appendBanner("KeyboardInterrupt");
      this.deps.view.setPrompt("primary");
    }
  }

  private handleClearRequested(): void {
    this.deps.view.clear();
  }

  /* -------- Submission flow -------- */

  /**
   * The view sends one logical submission per Enter; multi-line content
   * (Shift+Enter or pasted text with newlines) is unrolled into per-line
   * processing here so each line gets its own echo entry and the
   * continuation tracking matches CPython's interactive shell.
   */
  private async processSubmission(rawCode: string): Promise<void> {
    if (!this.initialized) {
      const ok = await this.ensureInitialized();
      if (!ok) return;
    }
    const lines = rawCode.split(/\r?\n/);
    for (const line of lines) {
      await this.processLine(line);
    }
  }

  private async processLine(rawLine: string): Promise<void> {
    const promptUsed: ">>>" | "..." = this.continuing ? "..." : ">>>";
    this.deps.view.appendEcho(promptUsed, rawLine);

    if (this.continuing) {
      if (rawLine.trim() === "") {
        const code = this.continuationLines.join("\n");
        this.continuationLines = [];
        this.continuing = false;
        this.deps.view.setPrompt("primary");
        if (code.trim() === "") return;
        await this.enqueue(() => this.executeRepl(code));
        return;
      }
      this.continuationLines.push(rawLine);
      const buffered = this.continuationLines.join("\n");
      const status = await this.deps.runtime.checkReplComplete(buffered);
      if (status.status === "complete") {
        this.continuationLines = [];
        this.continuing = false;
        this.deps.view.setPrompt("primary");
        await this.enqueue(() => this.executeRepl(buffered));
      } else {
        this.deps.view.setPrompt("continuation");
      }
      return;
    }

    if (rawLine.trim() === "") {
      // Empty primary-prompt line: just keep the prompt as-is.
      return;
    }

    const status = await this.deps.runtime.checkReplComplete(rawLine);
    if (status.status === "incomplete") {
      this.continuationLines.push(rawLine);
      this.continuing = true;
      this.deps.view.setPrompt("continuation");
      return;
    }

    await this.enqueue(() => this.executeRepl(rawLine));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.execChain.then(task);
    this.execChain = next.catch(() => undefined);
    return next;
  }

  /* -------- Execution -------- */

  private async executeRepl(code: string): Promise<void> {
    this.deps.view.setBusy(true);
    try {
      // The REPL itself is always expert level - we never run static checks
      // against ad-hoc prompt input.
      await this.deps.runtime.replEval({ code }, (event) =>
        this.handleEvent(event, code, "<repl>", undefined, "expert"),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.view.appendStderr(`Internal error: ${msg}`);
    } finally {
      this.flushStreams();
      this.deps.view.setBusy(false);
    }
  }

  private async executeFile(
    code: string,
    fileName: string,
    document?: vscode.TextDocument,
  ): Promise<void> {
    // Run File starts a fresh session for the user: drop any unfinished
    // multi-line REPL buffer and reset to the primary prompt.
    this.continuationLines = [];
    this.continuing = false;
    this.deps.view.setPrompt("primary");

    this.deps.view.clear();
    this.deps.view.setBusy(true);

    if (document) {
      this.deps.diagnostics.clear(document.uri);
      this.deps.view.registerFile(fileName, document.uri);
    }

    const level = parseLevel(code);

    try {
      if (level === "beginner") {
        const blocked = await this.runStaticChecks(code, fileName, level, document);
        if (blocked) {
          this.deps.view.appendBanner(
            "Static analysis found issues. File not executed.",
          );
          return;
        }
      }

      await this.deps.runtime.runFile({ code, fileName }, (event) =>
        this.handleEvent(event, code, fileName, document, level),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.view.appendStderr(`Internal error: ${msg}`);
    } finally {
      this.flushStreams();
      this.deps.view.setBusy(false);
    }
  }

  private async runStaticChecks(
    code: string,
    fileName: string,
    level: Level,
    document: vscode.TextDocument | undefined,
  ): Promise<boolean> {
    let raw;
    try {
      raw = await this.deps.runtime.staticAnalyze({ code, fileName, level });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.view.appendStderr(`Static analysis failed: ${msg}`);
      return false;
    }
    const findings = enrichStaticFindings(raw, level, fileName);
    if (findings.length === 0) {
      if (document) this.deps.diagnostics.clear(document.uri);
      return false;
    }
    for (const finding of findings) {
      this.deps.view.appendFinding(finding);
    }
    if (document) {
      this.deps.diagnostics.setFindings(document.uri, document, findings);
    }
    return true;
  }

  /* -------- Event handling -------- */

  private handleEvent(
    event: ExecutionEvent,
    source: string,
    fileName: string,
    document: vscode.TextDocument | undefined,
    level: Level,
  ): void {
    switch (event.kind) {
      case "stdout":
        this.feedStream("stdout", event.text);
        break;
      case "stderr":
        this.feedStream("stderr", event.text);
        break;
      case "result":
        this.flushStreams();
        if (event.repr !== null && event.repr !== undefined) {
          this.deps.view.appendResult(event.repr);
        }
        break;
      case "image":
        this.flushStreams();
        this.deps.view.appendImage({
          svg: event.svg,
          width: event.width,
          height: event.height,
          source: event.source ?? fileName,
        });
        break;
      case "error": {
        this.flushStreams();
        const traceback = event.traceback || `${event.errorType}: ${event.message}`;
        const parsed = parsePythonError(traceback);
        if (parsed.lineNumber === null && event.lineNumber !== null) {
          parsed.lineNumber = event.lineNumber;
        }
        if (parsed.column === null && event.column !== null) {
          parsed.column = event.column;
        }
        if (parsed.fileName === null && event.fileName) {
          parsed.fileName = event.fileName;
        }
        const finding = findRuntimeFinding(source, fileName, level, parsed);
        if (finding) {
          this.deps.view.appendFinding(finding);
          if (document) {
            this.deps.diagnostics.setFinding(document.uri, document, finding);
          }
        } else {
          this.deps.view.appendRawError(event.errorType, event.message, traceback);
        }
        break;
      }
      case "done":
        this.flushStreams();
        break;
    }
  }

  /* -------- Stream batching -------- */

  /**
   * Buffer stream output and flush whole lines as Entries. This avoids
   * one Entry per chunk when Python flushes mid-line (e.g. `print(end="")`).
   */
  private feedStream(kind: "stdout" | "stderr", text: string): void {
    let buf = kind === "stdout" ? this.stdoutBuf : this.stderrBuf;
    buf += text;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.substring(0, idx);
      if (kind === "stdout") this.deps.view.appendStdout(line);
      else this.deps.view.appendStderr(line);
      buf = buf.substring(idx + 1);
    }
    if (kind === "stdout") this.stdoutBuf = buf;
    else this.stderrBuf = buf;
  }

  private flushStreams(): void {
    if (this.stdoutBuf.length > 0) {
      this.deps.view.appendStdout(this.stdoutBuf);
      this.stdoutBuf = "";
    }
    if (this.stderrBuf.length > 0) {
      this.deps.view.appendStderr(this.stderrBuf);
      this.stderrBuf = "";
    }
  }
}
