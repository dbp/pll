import * as vscode from "vscode";
import { findRuntimeFinding } from "./analyzers/registry";
import { enrichStaticFindings } from "./analyzers/static/registry";
import type { Diagnostics } from "./diagnostics";
import { parsePythonError } from "./errors/pythonErrorParser";
import {
  type InteractionsView,
  type Entry,
  type PromptKind,
  serializeFinding,
} from "./interactionsView";
import { DEFAULT_LEVEL, levelHasStaticChecks, parseLevel, type Level } from "./level";
import type { ExecutionEvent, PythonRuntime } from "./types";
import { collectSiblingFiles, folderUri, writeBackSiblingFiles } from "./workspaceFiles";

export interface ReplDeps {
  runtime: PythonRuntime;
  diagnostics: Diagnostics;
  view: InteractionsView;
}

/**
 * A per-Python-file logical session. Owns its own entry log, REPL
 * continuation buffer, and (on the Python side, by sharing the same
 * `key`) its own globals dict, so each file's `Run File` and REPL
 * evaluations are independent.
 *
 * Pyodide is single-threaded so executions are serialized through one
 * shared exec chain; while one session is executing, submissions to
 * another simply queue up.
 */
interface Session {
  /** Session id (also the key Python uses for its globals). */
  key: string;
  /** Most recently observed display name (e.g. "hello.py"). */
  fileName: string;
  /** URI of the underlying document, used for diagnostics + open-location. */
  documentUri: vscode.Uri;
  entries: Entry[];
  history: string[];
  prompt: PromptKind;
  busy: boolean;
  /** Shown while `busy` (e.g. "Loading libraries..."). */
  status?: string;
  continuationLines: string[];
  continuing: boolean;
  /**
   * Language level of the most recent Run File on this session. `null`
   * until the file has been run at least once. We surface this in the
   * header (e.g. `hello.py [beginner]`) so it's easy to tell which rule
   * set is currently in effect after a run.
   */
  lastLevel: Level | null;
}

/**
 * Routes user input + run-file events to the correct per-file session and
 * keeps the interactions view showing whichever session corresponds to the
 * active Python editor. Owns the single Pyodide exec chain.
 */
export class ReplSession implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  /** Currently-shown session key, or null if no Python file has been active. */
  private activeKey: string | null = null;

  /** All Python operations serialize through this chain (Pyodide is single-threaded). */
  private execChain: Promise<void> = Promise.resolve();

  private initialized = false;
  private initPromise: Promise<boolean> | null = null;

  private readonly editorWatcher: vscode.Disposable;

  /** Line-buffered stream output, keyed by session. */
  private readonly streamBuffers = new Map<
    string,
    { stdout: string; stderr: string }
  >();

  /**
   * Session whose file is currently executing `input()`. Either runtime
   * calls `provideStdin` while that run is blocked in the worker.
   */
  private stdinSession: Session | null = null;
  private stdinPending: {
    session: Session;
    prefix: string;
    resolve: (line: string | null) => void;
  } | null = null;

  constructor(private readonly deps: ReplDeps) {
    deps.view.setHandlers({
      onSubmit: (code) => this.handleSubmit(code),
      onInterrupt: () => this.handleInterrupt(),
      onClearRequested: () => this.handleClearRequested(),
    });
    deps.runtime.setStdinHandler(() => this.provideStdin());

    // Keep the visible session in sync with the active editor.
    this.editorWatcher = vscode.window.onDidChangeActiveTextEditor((editor) =>
      this.handleActiveEditorChange(editor),
    );
    // Pick up the editor that's already active at activation time (the
    // common case when the extension activates via `onLanguage:python`).
    this.handleActiveEditorChange(vscode.window.activeTextEditor);

    // Eagerly start Pyodide so first interaction isn't blocked by load time.
    void this.ensureInitialized();
  }

  /** Reveal the interactions view (creates it on first call). */
  show(preserveFocus = false): void {
    void this.deps.view.reveal({ preserveFocus });
  }

  /** Run a file in its own session (creates the session if needed). */
  async runFile(
    code: string,
    fileName: string,
    document: vscode.TextDocument,
  ): Promise<void> {
    const session = this.getOrCreateSession(document.uri, fileName);
    this.show(false);
    // Switching active to this session ensures the user sees the run output
    // even if they're currently looking at a different file's session.
    this.setActive(session.key);
    this.cancelStdin();
    return this.enqueue(() => this.executeFile(session, code, fileName, document));
  }

  dispose(): void {
    this.editorWatcher.dispose();
  }

  /* -------- Init -------- */

  private async ensureInitialized(): Promise<boolean> {
    if (this.initPromise) return this.initPromise;
    // Surface "Loading..." status on the active session (if any).
    this.refreshActiveBusy();
    this.initPromise = (async () => {
      try {
        await this.deps.runtime.initialize();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.activeKey !== null) {
          this.deps.view.appendRawError("InitializationError", msg, "");
        }
        return false;
      }
      this.initialized = true;
      this.refreshActiveBusy();
      return true;
    })();
    return this.initPromise;
  }

  /* -------- Active editor tracking -------- */

  private handleActiveEditorChange(
    editor: vscode.TextEditor | undefined,
  ): void {
    if (!editor) return;
    if (editor.document.languageId !== "python") return;
    const fileName = displayName(editor.document.uri);
    const session = this.getOrCreateSession(editor.document.uri, fileName);

    const titleChanged = session.fileName !== fileName;
    session.fileName = fileName;
    session.documentUri = editor.document.uri;

    if (this.activeKey !== session.key) {
      this.setActive(session.key);
    } else if (titleChanged) {
      // Same session re-activated but its display name changed - propagate
      // to the title without re-replaying the whole stream.
      this.deps.view.setTitle(this.titleFor(session));
    }
  }

  private setActive(key: string): void {
    if (this.activeKey === key) return;
    this.activeKey = key;
    const session = this.sessions.get(key);
    if (!session) return;
    this.deps.view.showSession({
      title: this.titleFor(session),
      entries: session.entries,
      prompt: session.prompt,
      busy: this.computeVisibleBusy(session),
      status: this.visibleStatus(session),
      awaitingInput: this.stdinPending?.session === session,
      inputPrefix: this.stdinPending?.session === session ? this.stdinPending.prefix : "",
    });
  }

  /* -------- Session bookkeeping -------- */

  private getOrCreateSession(uri: vscode.Uri, fileName: string): Session {
    const key = uri.toString();
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        key,
        fileName,
        documentUri: uri,
        entries: [],
        history: [],
        prompt: "primary",
        busy: false,
        status: undefined,
        continuationLines: [],
        continuing: false,
        lastLevel: null,
      };
      this.sessions.set(key, session);
      this.streamBuffers.set(key, { stdout: "", stderr: "" });
    }
    return session;
  }

  /** The string we display as the view's header for `session`. */
  private titleFor(session: Session): string {
    return session.lastLevel
      ? `${session.fileName} [${session.lastLevel}]`
      : session.fileName;
  }

  private isActive(session: Session): boolean {
    return this.activeKey === session.key;
  }

  private computeVisibleBusy(session: Session): boolean {
    return !this.initialized || session.busy;
  }

  private visibleStatus(session: Session): string | undefined {
    if (!this.initialized) {
      return "Loading Python...";
    }
    if (session.busy) {
      return session.status ?? "Running...";
    }
    return undefined;
  }

  private refreshActiveBusy(): void {
    if (this.activeKey === null) return;
    const session = this.sessions.get(this.activeKey);
    if (!session) return;
    this.deps.view.setBusy(
      this.computeVisibleBusy(session),
      this.visibleStatus(session),
    );
  }

  /* -------- Per-session view helpers -------- */

  private appendToSession(session: Session, entry: Entry): void {
    session.entries.push(entry);
    if (this.isActive(session)) this.deps.view.append(entry);
  }

  private setSessionPrompt(session: Session, kind: PromptKind): void {
    session.prompt = kind;
    if (this.isActive(session)) this.deps.view.setPrompt(kind);
  }

  private setSessionBusy(session: Session, busy: boolean, status?: string): void {
    session.busy = busy;
    session.status = busy ? (status ?? this.visibleStatus(session) ?? "Running...") : undefined;
    if (this.isActive(session)) {
      this.deps.view.setBusy(this.computeVisibleBusy(session), this.visibleStatus(session));
    }
  }

  private clearSession(session: Session): void {
    session.entries = [];
    if (this.isActive(session)) this.deps.view.clear();
  }

  /* -------- Handlers from the view -------- */

  private handleSubmit(code: string): void {
    if (
      this.stdinPending &&
      this.activeKey === this.stdinPending.session.key
    ) {
      this.fulfillStdin(code.split(/\r?\n/)[0] ?? "");
      return;
    }
    if (this.activeKey === null) return;
    const session = this.sessions.get(this.activeKey);
    if (!session) return;
    void this.processSubmission(session, code);
  }

  private handleInterrupt(): void {
    if (
      this.stdinPending &&
      this.activeKey === this.stdinPending.session.key
    ) {
      this.fulfillStdin(null);
      return;
    }
    if (this.activeKey === null) return;
    const session = this.sessions.get(this.activeKey);
    if (!session) return;
    if (session.continuing) {
      session.continuationLines = [];
      session.continuing = false;
      this.appendToSession(session, { kind: "banner", text: "KeyboardInterrupt" });
      this.setSessionPrompt(session, "primary");
    }
  }

  private handleClearRequested(): void {
    if (this.activeKey === null) return;
    const session = this.sessions.get(this.activeKey);
    if (!session) return;
    this.clearSession(session);
  }

  /* -------- Submission flow (matches CPython's interactive shell) -------- */

  private async processSubmission(session: Session, rawCode: string): Promise<void> {
    if (!this.initialized) {
      const ok = await this.ensureInitialized();
      if (!ok) return;
    }
    const lines = rawCode.split(/\r?\n/);
    for (const line of lines) {
      await this.processLine(session, line);
    }
  }

  private async processLine(session: Session, rawLine: string): Promise<void> {
    const promptUsed: ">>>" | "..." = session.continuing ? "..." : ">>>";
    this.appendToSession(session, { kind: "echo", prompt: promptUsed, code: rawLine });

    if (session.continuing) {
      if (rawLine.trim() === "") {
        const code = session.continuationLines.join("\n");
        session.continuationLines = [];
        session.continuing = false;
        this.setSessionPrompt(session, "primary");
        if (code.trim() === "") return;
        await this.enqueue(() => this.executeRepl(session, code));
        return;
      }
      session.continuationLines.push(rawLine);
      const buffered = session.continuationLines.join("\n");
      const status = await this.deps.runtime.checkReplComplete(buffered);
      if (status.status === "complete") {
        session.continuationLines = [];
        session.continuing = false;
        this.setSessionPrompt(session, "primary");
        await this.enqueue(() => this.executeRepl(session, buffered));
      } else {
        this.setSessionPrompt(session, "continuation");
      }
      return;
    }

    if (rawLine.trim() === "") {
      // Empty primary-prompt line: keep the prompt as-is.
      return;
    }

    const status = await this.deps.runtime.checkReplComplete(rawLine);
    if (status.status === "incomplete") {
      session.continuationLines.push(rawLine);
      session.continuing = true;
      this.setSessionPrompt(session, "continuation");
      return;
    }

    await this.enqueue(() => this.executeRepl(session, rawLine));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.execChain.then(task);
    this.execChain = next.catch(() => undefined);
    return next;
  }

  /* -------- Execution -------- */

  private async executeRepl(session: Session, code: string): Promise<void> {
    const level = session.lastLevel ?? DEFAULT_LEVEL;
    this.setSessionBusy(session, true, "Starting...");
    try {
      if (levelHasStaticChecks(level)) {
        this.setSessionBusy(session, true, "Checking...");
        const blocked = await this.runReplStaticChecks(session, code, level);
        if (blocked) {
          return;
        }
      }
      await this.ensurePackagesForRun(session, code);
      this.setSessionBusy(session, true, "Loading files...");
      const workspaceReady = await this.syncWorkspaceIn(session);
      this.setSessionBusy(session, true, "Running...");
      try {
        await this.deps.runtime.replEval(
          { code, sessionKey: session.key },
          (event) => this.handleEvent(session, event, code, "<repl>", undefined, level),
        );
      } finally {
        this.flushStreams(session);
        if (workspaceReady) {
          await this.syncWorkspaceOut(session);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.feedStream(session, "stderr", `Internal error: ${msg}\n`);
    } finally {
      this.flushStreams(session);
      this.setSessionBusy(session, false);
    }
  }

  private async executeFile(
    session: Session,
    code: string,
    fileName: string,
    document: vscode.TextDocument,
  ): Promise<void> {
    // Run File starts a fresh session run: drop any unfinished multi-line
    // REPL buffer, reset to the primary prompt, and clear the visible stream.
    session.continuationLines = [];
    session.continuing = false;
    this.setSessionPrompt(session, "primary");
    this.clearSession(session);
    this.setSessionBusy(session, true, this.initialized ? "Starting..." : "Loading Python...");

    this.deps.diagnostics.clear(document.uri);
    this.deps.view.registerFile(fileName, document.uri);

    const level = parseLevel(code);
    // Record the level *before* running so the header reflects it even if
    // the run aborts due to static-analysis errors.
    session.lastLevel = level;
    if (this.isActive(session)) {
      this.deps.view.setTitle(this.titleFor(session));
    }

    let workspaceReady = false;
    try {
      if (!this.initialized) {
        const ok = await this.ensureInitialized();
        if (!ok) {
          return;
        }
        this.setSessionBusy(session, true, "Starting...");
      }
      if (levelHasStaticChecks(level)) {
        this.setSessionBusy(session, true, "Checking...");
        const blocked = await this.runStaticChecks(session, code, fileName, level, document);
        if (blocked) {
          this.appendToSession(session, {
            kind: "banner",
            text: "Static analysis found issues. File not executed.",
          });
          return;
        }
      }

      await this.ensurePackagesForRun(session, code);
      this.setSessionBusy(session, true, "Loading files...");
      workspaceReady = await this.syncWorkspaceIn(session);

      let hasTests = false;
      try {
        hasTests = await this.deps.runtime.hasTests(code);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.feedStream(session, "stderr", `Could not check for tests: ${msg}\n`);
      }
      if (hasTests) {
        this.setSessionBusy(session, true, "Loading pytest...");
        try {
          await this.deps.runtime.ensurePytest();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendToSession(session, {
            kind: "banner",
            text: `Could not load pytest (${msg}). Skipping tests.`,
          });
          hasTests = false;
        }
      }
      if (hasTests) {
        this.setSessionBusy(session, true, "Running tests...");
        await this.deps.runtime.runTests(
          { code, fileName, sessionKey: session.key },
          (event) => this.handleEvent(session, event, code, fileName, document, level),
        );
      }

      this.setSessionBusy(session, true, "Running...");
      this.stdinSession = session;
      try {
        await this.deps.runtime.runFile(
          { code, fileName, sessionKey: session.key },
          (event) => this.handleEvent(session, event, code, fileName, document, level),
        );
      } finally {
        this.stdinSession = null;
        this.cancelStdin();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.feedStream(session, "stderr", `Internal error: ${msg}\n`);
    } finally {
      this.flushStreams(session);
      if (workspaceReady) {
        await this.syncWorkspaceOut(session);
      }
      this.setSessionBusy(session, false);
    }
  }

  /**
   * Snapshot sibling files into Pyodide so `open` / `read_csv` see the
   * folder next to the running script. Always remounts (even if empty)
   * so a previous file's leftovers do not leak into this run.
   */
  private async syncWorkspaceIn(session: Session): Promise<boolean> {
    try {
      const files = folderUri(session.documentUri)
        ? await collectSiblingFiles(session.documentUri)
        : [];
      await this.deps.runtime.mountWorkspaceFiles(files);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendToSession(session, {
        kind: "banner",
        text: `Could not load files next to this script (${msg}). open() may fail.`,
      });
      return false;
    }
  }

  /**
   * Copy data files Python created or changed back into the script's folder.
   */
  private async syncWorkspaceOut(session: Session): Promise<void> {
    if (!folderUri(session.documentUri)) {
      return;
    }
    try {
      const changed = await this.deps.runtime.collectWorkspaceFiles();
      if (changed.length === 0) {
        return;
      }
      const written = await writeBackSiblingFiles(session.documentUri, changed);
      if (written.length === 1) {
        this.appendToSession(session, {
          kind: "banner",
          text: `Saved ${written[0]} next to this file.`,
        });
      } else if (written.length > 1) {
        this.appendToSession(session, {
          kind: "banner",
          text: `Saved ${written.join(", ")} next to this file.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendToSession(session, {
        kind: "banner",
        text: `Could not save files next to this script (${msg}).`,
      });
    }
  }

  /**
   * Load any third-party packages the code imports (pandas, numpy, ...) before
   * running it. Only reaches the runtime when the code actually has an import,
   * so plain REPL lines don't pay a round-trip. Non-fatal: if a load fails, the
   * import itself surfaces the error when the code runs.
   */
  private async ensurePackagesForRun(session: Session, code: string): Promise<void> {
    if (!/(^|\n)[ \t]*(import|from)[ \t]+\S/.test(code)) {
      return;
    }
    this.setSessionBusy(session, true, "Loading libraries...");
    try {
      await this.deps.runtime.ensurePackages(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A SyntaxError here just means the file doesn't parse; the run itself
      // will surface it. Only flag genuine load/network failures.
      if (!/syntaxerror|invalid syntax/i.test(msg)) {
        this.appendToSession(session, {
          kind: "banner",
          text: `Could not load libraries (${msg}). Continuing; imports may fail.`,
        });
      }
    }
  }

  /**
   * Called from the runtime when the worker is blocked in `input()`.
   * The unflushed stdout buffer is the prompt (`input("Choice: ")`).
   */
  private provideStdin(): Promise<string | null> {
    const session = this.stdinSession;
    if (!session) {
      return Promise.resolve(null);
    }
    const buffers = this.streamBuffers.get(session.key);
    const prefix = buffers ? buffers.stdout : "";
    if (buffers) {
      buffers.stdout = "";
    }
    this.setSessionBusy(session, true, "Waiting for input...");
    if (this.isActive(session)) {
      this.deps.view.setAwaitingInput(true, prefix);
      this.deps.view.focusInput();
    }
    return new Promise((resolve) => {
      this.stdinPending = { session, prefix, resolve };
    });
  }

  private fulfillStdin(line: string | null): void {
    const pending = this.stdinPending;
    if (!pending) {
      return;
    }
    this.stdinPending = null;
    if (line !== null) {
      this.appendToSession(pending.session, {
        kind: "stdout",
        text: pending.prefix + line,
      });
    }
    if (this.isActive(pending.session)) {
      this.deps.view.setAwaitingInput(false);
      this.deps.view.setBusy(true, "Running...");
    }
    pending.resolve(line);
  }

  /** Unblock a waiting `input()` with EOF so a new run / interrupt can proceed. */
  private cancelStdin(): void {
    if (!this.stdinPending) {
      return;
    }
    this.fulfillStdin(null);
  }

  private async runStaticChecks(
    session: Session,
    code: string,
    fileName: string,
    level: Level,
    document: vscode.TextDocument,
  ): Promise<boolean> {
    let raw;
    try {
      raw = await this.deps.runtime.staticAnalyze({ code, fileName, level });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.feedStream(session, "stderr", `Static analysis failed: ${msg}\n`);
      return false;
    }
    const findings = enrichStaticFindings(raw, level, fileName);
    if (findings.length === 0) {
      this.deps.diagnostics.clear(document.uri);
      return false;
    }
    for (const finding of findings) {
      this.appendToSession(session, {
        kind: "finding",
        finding: serializeFinding(finding),
      });
    }
    this.deps.diagnostics.setFindings(document.uri, document, findings);
    return true;
  }

  /**
   * Static-check a prompt snippet at the session's last-run level.
   * Findings stay in the interactions view; they are not mapped onto the
   * `.py` file (snippet line numbers are not file line numbers).
   */
  private async runReplStaticChecks(
    session: Session,
    code: string,
    level: Level,
  ): Promise<boolean> {
    let raw;
    try {
      raw = await this.deps.runtime.staticAnalyze({
        code,
        fileName: "<repl>",
        level,
        sessionKey: session.key,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.feedStream(session, "stderr", `Static analysis failed: ${msg}\n`);
      return false;
    }
    const findings = enrichStaticFindings(raw, level, "<repl>");
    if (findings.length === 0) {
      return false;
    }
    for (const finding of findings) {
      this.appendToSession(session, {
        kind: "finding",
        finding: serializeFinding(finding),
      });
    }
    this.appendToSession(session, {
      kind: "banner",
      text: "Static analysis found issues. Input not executed.",
    });
    return true;
  }

  /* -------- Event handling -------- */

  private handleEvent(
    session: Session,
    event: ExecutionEvent,
    source: string,
    fileName: string,
    document: vscode.TextDocument | undefined,
    level: Level,
  ): void {
    switch (event.kind) {
      case "stdout":
        this.feedStream(session, "stdout", event.text);
        break;
      case "stderr":
        this.feedStream(session, "stderr", event.text);
        break;
      case "result":
        this.flushStreams(session);
        if (event.repr !== null && event.repr !== undefined) {
          this.appendToSession(session, { kind: "result", repr: event.repr });
        }
        break;
      case "image":
        this.flushStreams(session);
        this.appendToSession(session, {
          kind: "image",
          svg: event.svg,
          width: event.width,
          height: event.height,
          source: event.source ?? fileName,
        });
        break;
      case "table":
        this.flushStreams(session);
        this.appendToSession(session, {
          kind: "table",
          columns: event.columns,
          rows: event.rows,
          rowCount: event.rowCount,
          shownCount: event.shownCount,
          truncated: event.truncated,
          source: event.source ?? fileName,
        });
        break;
      case "error": {
        this.flushStreams(session);
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
          this.appendToSession(session, {
            kind: "finding",
            finding: serializeFinding(finding),
          });
          if (document) {
            this.deps.diagnostics.setFinding(document.uri, document, finding);
          }
        } else {
          this.appendToSession(session, {
            kind: "rawError",
            errorType: event.errorType,
            message: event.message,
            traceback,
          });
        }
        break;
      }
      case "done":
        this.flushStreams(session);
        break;
      case "testReport":
        this.flushStreams(session);
        this.appendToSession(session, {
          kind: "testReport",
          fileName: event.fileName,
          passed: event.passed,
          failed: event.failed,
          skipped: event.skipped,
          errors: event.errors,
          tests: event.tests,
        });
        break;
    }
  }

  /* -------- Stream batching (per session) -------- */

  /**
   * Buffer stream output and flush whole lines as Entries. This avoids
   * one Entry per chunk when Python flushes mid-line (e.g. `print(end="")`).
   */
  private feedStream(
    session: Session,
    kind: "stdout" | "stderr",
    text: string,
  ): void {
    const buffers = this.streamBuffers.get(session.key)!;
    let buf = buffers[kind] + text;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.substring(0, idx);
      this.appendToSession(session, { kind, text: line });
      buf = buf.substring(idx + 1);
    }
    buffers[kind] = buf;
  }

  private flushStreams(session: Session): void {
    const buffers = this.streamBuffers.get(session.key);
    if (!buffers) return;
    if (buffers.stdout.length > 0) {
      this.appendToSession(session, { kind: "stdout", text: buffers.stdout });
      buffers.stdout = "";
    }
    if (buffers.stderr.length > 0) {
      this.appendToSession(session, { kind: "stderr", text: buffers.stderr });
      buffers.stderr = "";
    }
  }
}

function displayName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.toString();
}
