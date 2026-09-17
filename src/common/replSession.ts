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
import type { RawStaticFinding } from "./pyodideRunner";
import { ANY_IMPORT_RE, type ReactorStepResult } from "./pyodideRunner";
import type { ExecutionEvent, PythonRuntime } from "./types";
import {
  unavailableSocket,
  validateUniverseUrl,
  type UniverseConnect,
  type UniverseSocket,
  type UniverseStatus,
} from "./universeClient";
import { collectSiblingFiles, folderUri, writeBackSiblingFiles } from "./workspaceFiles";

/**
 * How long to wait after a Stop before telling the student it did not work.
 * A KeyboardInterrupt lands at the interpreter's next bytecode check, which
 * for ordinary Python is immediate; anything still running after this is
 * stuck somewhere the interrupt cannot reach.
 */
export const STOP_TIMEOUT_MS = 3000;

/**
 * Most lines of program output rendered for a single run.
 *
 * The worker coalesces its stream messages, but `feedStream` still turns
 * each line into its own entry and its own webview message, so a runaway
 * `print` loop would put hundreds of thousands of nodes into the panel and
 * starve the extension host - exactly when Stop needs to be responsive.
 * Well above anything a normal exercise prints.
 */
export const MAX_STREAM_LINES_PER_RUN = 5000;

export interface ReplDeps {
  runtime: PythonRuntime;
  diagnostics: Diagnostics;
  view: InteractionsView;
  connectUniverse: UniverseConnect;
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
  /** Partial stream output, flushed to entries a line at a time. */
  streams: { stdout: string; stderr: string };
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
  /**
   * Incremented at the start of each run. `requestStop` captures it so its
   * "did not stop" check cannot fire against a later run that happens to be
   * busy by then.
   */
  runSeq: number;
  /** Lines of program output rendered so far in the current run. */
  streamLines: number;
  /** Whether this run already reported that output was cut off. */
  streamTruncated: boolean;
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
  /** Why Pyodide failed to start, if it did. */
  private initError: string | null = null;

  private readonly editorWatcher: vscode.Disposable;

  /**
   * Session whose file is currently executing `input()`. Either runtime
   * calls `provideStdin` while that run is blocked in the worker.
   */
  private stdinSession: Session | null = null;
  /** Sessions with a Stop in flight, so repeated presses don't stack banners. */
  private readonly stopPending = new Set<string>();
  /** Reactors currently shown in the panel, keyed by the Python-side id. */
  private readonly reactors = new Map<string, ReactorDriver>();
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
      onReactorControl: (id, action, index) => this.handleReactorControl(id, action, index),
      onReactorInput: (id, event) => this.handleReactorInput(id, event as ReactorEvent),
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

  /** Run a file in its own session (creates the session if needed). */
  async runFile(
    code: string,
    fileName: string,
    document: vscode.TextDocument,
  ): Promise<void> {
    const session = this.getOrCreateSession(document.uri, fileName);
    void this.deps.view.reveal({ preserveFocus: false });
    // Switching active to this session ensures the user sees the run output
    // even if they're currently looking at a different file's session.
    this.setActive(session.key);
    this.cancelStdin();
    return this.enqueue(() => this.executeFile(session, code, fileName, document));
  }

  /**
   * Stop whatever the visible session is running. Same behavior as Ctrl+C in
   * the interactions panel, reachable from the command palette and the
   * panel's Stop button.
   */
  stopActiveProgram(): void {
    this.handleInterrupt();
  }

  dispose(): void {
    for (const id of [...this.reactors.keys()]) {
      this.disposeReactor(id, { fromPython: false });
    }
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
        this.initError = errorMessage(err);
        return false;
      }
      this.initialized = true;
      this.refreshActiveBusy();
      return true;
    })();
    return this.initPromise;
  }

  /**
   * Record a failed Pyodide start in the session's own log. `initPromise` is
   * memoized, so this has to be reported per attempt rather than once: the
   * eager warm-up in the constructor has no session to report against, and a
   * later Run File clears the stream before it asks.
   */
  private reportInitFailure(session: Session): void {
    this.appendToSession(session, {
      kind: "rawError",
      errorType: "InitializationError",
      message: this.initError ?? "Python could not be started.",
      traceback: "",
    });
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
      inputPrefix:
        this.stdinPending?.session === session ? this.stdinPending.prefix : "",
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
        streams: { stdout: "", stderr: "" },
        prompt: "primary",
        busy: false,
        continuationLines: [],
        continuing: false,
        lastLevel: null,
        runSeq: 0,
        streamLines: 0,
        streamTruncated: false,
      };
      this.sessions.set(key, session);
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

  /** The session the interactions view is currently showing, if any. */
  private activeSession(): Session | null {
    return (this.activeKey !== null ? this.sessions.get(this.activeKey) : undefined) ?? null;
  }

  /** True when a running program is blocked in `input()` on the visible session. */
  private isAwaitingInputOnActive(): boolean {
    return this.stdinPending !== null && this.stdinPending.session.key === this.activeKey;
  }

  /**
   * True while Pyodide is still starting. A *failed* start is not "loading":
   * treating it as busy left the view spinning forever with no way out.
   */
  private get loadingPython(): boolean {
    return !this.initialized && this.initError === null;
  }

  private computeVisibleBusy(session: Session): boolean {
    return this.loadingPython || session.busy;
  }

  private visibleStatus(session: Session): string | undefined {
    if (this.loadingPython) {
      return "Loading Python...";
    }
    if (session.busy) {
      return session.status ?? "Running...";
    }
    return undefined;
  }

  private refreshActiveBusy(): void {
    const session = this.activeSession();
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
    // Cards are going away, so their clocks must stop with them.
    this.disposeReactorsFor(session);
    session.entries = [];
    if (this.isActive(session)) this.deps.view.clear();
  }

  /* -------- Handlers from the view -------- */

  private handleSubmit(code: string): void {
    if (this.isAwaitingInputOnActive()) {
      this.fulfillStdin(code.split(/\r?\n/)[0] ?? "");
      return;
    }
    const session = this.activeSession();
    if (session) void this.processSubmission(session, code);
  }

  private handleInterrupt(): void {
    // Blocked in `input()`: cancelling the read is the interrupt.
    if (this.isAwaitingInputOnActive()) {
      this.fulfillStdin(null);
      return;
    }
    const session = this.activeSession();
    if (!session) {
      return;
    }
    // A program is running: ask the interpreter to raise KeyboardInterrupt.
    if (session.busy) {
      this.requestStop(session);
      return;
    }
    // Otherwise the only thing to abandon is a half-typed multi-line snippet.
    if (session.continuing) {
      session.continuationLines = [];
      session.continuing = false;
      this.appendToSession(session, { kind: "banner", text: "KeyboardInterrupt" });
      this.setSessionPrompt(session, "primary");
    }
  }

  /**
   * Ask the worker to stop the running program.
   *
   * The interpreter checks for signals between bytecodes, so this cannot
   * reach a tight loop inside a C extension (a long numpy call), and student
   * code with a bare `except:` can swallow the KeyboardInterrupt just as it
   * would in CPython. Neither case may look like Stop silently did nothing,
   * so we check back and say what happened.
   */
  private requestStop(session: Session): void {
    if (!this.deps.runtime.interrupt()) {
      this.appendToSession(session, {
        kind: "banner",
        text:
          "Cannot stop the program in this window (SharedArrayBuffer is unavailable). " +
          "Reload the window to recover.",
      });
      return;
    }
    if (this.stopPending.has(session.key)) {
      return;
    }
    this.stopPending.add(session.key);
    const runSeq = session.runSeq;
    this.setSessionBusy(session, true, "Stopping...");
    setTimeout(() => {
      this.stopPending.delete(session.key);
      if (!session.busy || session.runSeq !== runSeq) {
        return;
      }
      this.appendToSession(session, {
        kind: "banner",
        text:
          "The program has not stopped. It may be inside a library call, or catching " +
          "KeyboardInterrupt. Reload the window (Developer: Reload Window) to recover.",
      });
    }, STOP_TIMEOUT_MS);
  }

  private handleClearRequested(): void {
    const session = this.activeSession();
    if (session) this.clearSession(session);
  }

  /* -------- Submission flow (matches CPython's interactive shell) -------- */

  private async processSubmission(session: Session, rawCode: string): Promise<void> {
    if (!this.initialized && !(await this.ensureInitialized())) {
      this.reportInitFailure(session);
      return;
    }
    const lines = rawCode.split(/\r?\n/);
    for (const line of lines) {
      await this.processLine(session, line);
    }
  }

  private async processLine(session: Session, rawLine: string): Promise<void> {
    this.appendToSession(session, {
      kind: "echo",
      prompt: session.continuing ? "..." : ">>>",
      code: rawLine,
    });
    const blank = rawLine.trim() === "";

    if (!session.continuing) {
      // Empty primary-prompt line: nothing to do, keep the prompt as-is.
      if (blank) return;
      const status = await this.deps.runtime.checkReplComplete(rawLine);
      if (status.status === "incomplete") {
        session.continuationLines.push(rawLine);
        session.continuing = true;
        this.setSessionPrompt(session, "continuation");
        return;
      }
      return this.runSnippet(session, rawLine);
    }

    // A blank line ends a multi-line snippet, as it does in CPython's shell.
    if (!blank) {
      session.continuationLines.push(rawLine);
    }
    const buffered = session.continuationLines.join("\n");
    if (!blank) {
      const status = await this.deps.runtime.checkReplComplete(buffered);
      if (status.status !== "complete") {
        this.setSessionPrompt(session, "continuation");
        return;
      }
    }
    return this.runSnippet(session, buffered);
  }

  /** Reset the continuation buffer and queue `code` for evaluation. */
  private runSnippet(session: Session, code: string): Promise<void> {
    session.continuationLines = [];
    session.continuing = false;
    this.setSessionPrompt(session, "primary");
    if (code.trim() === "") {
      return Promise.resolve();
    }
    return this.enqueue(() => this.executeRepl(session, code));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.execChain.then(task);
    this.execChain = next.catch(() => undefined);
    return next;
  }

  /* -------- Execution -------- */

  /**
   * Shared envelope for every Python execution: load packages the code
   * imports, mount the sibling files, run, then flush pending output and
   * copy changed files back. Internal failures land in the session's stderr
   * instead of propagating.
   */
  private async execute(
    session: Session,
    code: string,
    run: () => Promise<void>,
  ): Promise<void> {
    let workspaceReady = false;
    try {
      await this.ensurePackagesForRun(session, code);
      this.setSessionBusy(session, true, "Loading files...");
      workspaceReady = await this.syncWorkspaceIn(session);
      this.setSessionBusy(session, true, "Running...");
      await run();
    } catch (err) {
      this.feedStream(session, "stderr", `Internal error: ${errorMessage(err)}\n`);
    } finally {
      this.flushStreams(session);
      if (workspaceReady) {
        await this.syncWorkspaceOut(session);
      }
      this.setSessionBusy(session, false);
    }
  }

  private async executeRepl(session: Session, code: string): Promise<void> {
    const level = session.lastLevel ?? DEFAULT_LEVEL;
    session.runSeq += 1;
    this.resetStreamBudget(session);
    this.setSessionBusy(session, true, "Starting...");
    if (levelHasStaticChecks(level)) {
      this.setSessionBusy(session, true, "Checking...");
      if (await this.runStaticChecks(session, code, "<repl>", level, undefined)) {
        this.flushStreams(session);
        this.setSessionBusy(session, false);
        return;
      }
    }
    await this.execute(session, code, () =>
      this.deps.runtime.replEval(
        { code, sessionKey: session.key, level },
        (event) =>
          this.handleEvent(session, event, code, "<repl>", undefined, level),
      ),
    );
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
    session.runSeq += 1;
    this.resetStreamBudget(session);
    this.setSessionPrompt(session, "primary");
    this.clearSession(session);
    this.setSessionBusy(session, true, "Starting...");

    this.deps.diagnostics.clear(document.uri);
    this.deps.view.registerFile(fileName, document.uri);

    const level = parseLevel(code);
    // Record the level *before* running so the header reflects it even if
    // the run aborts due to static-analysis errors.
    session.lastLevel = level;
    if (this.isActive(session)) {
      this.deps.view.setTitle(this.titleFor(session));
    }

    if (!this.initialized && !(await this.ensureInitialized())) {
      this.reportInitFailure(session);
      this.flushStreams(session);
      this.setSessionBusy(session, false);
      return;
    }
    // Re-post the status: until init finished it read "Loading Python...".
    this.setSessionBusy(session, true, "Starting...");
    if (levelHasStaticChecks(level)) {
      this.setSessionBusy(session, true, "Checking...");
      if (await this.runStaticChecks(session, code, fileName, level, document)) {
        this.flushStreams(session);
        this.setSessionBusy(session, false);
        return;
      }
    }

    const onEvent = (event: ExecutionEvent) =>
      this.handleEvent(session, event, code, fileName, document, level);
    await this.execute(session, code, async () => {
      if (await this.shouldRunTests(session, code)) {
        this.setSessionBusy(session, true, "Running tests...");
        await this.deps.runtime.runTests(
          { code, fileName, sessionKey: session.key, level },
          onEvent,
        );
      }
      this.setSessionBusy(session, true, "Running...");
      this.stdinSession = session;
      try {
        await this.deps.runtime.runFile(
          { code, fileName, sessionKey: session.key, level },
          onEvent,
        );
      } finally {
        this.stdinSession = null;
        this.cancelStdin();
      }
    });
  }

  /**
   * True if the file has `test_*` functions *and* pytest loaded. Both checks
   * are non-fatal: a failure here just means the file runs without tests.
   */
  private async shouldRunTests(session: Session, code: string): Promise<boolean> {
    try {
      if (!(await this.deps.runtime.hasTests(code))) {
        return false;
      }
    } catch (err) {
      this.feedStream(session, "stderr", `Could not check for tests: ${errorMessage(err)}\n`);
      return false;
    }
    this.setSessionBusy(session, true, "Loading pytest...");
    try {
      await this.deps.runtime.ensurePytest();
      return true;
    } catch (err) {
      this.appendToSession(session, {
        kind: "banner",
        text: `Could not load pytest (${errorMessage(err)}). Skipping tests.`,
      });
      return false;
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
      this.appendToSession(session, {
        kind: "banner",
        text:
          `Could not load files next to this script (${errorMessage(err)}). ` +
          "open() may fail.",
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
      if (written.length > 0) {
        this.appendToSession(session, {
          kind: "banner",
          text: `Saved ${written.join(", ")} next to this file.`,
        });
      }
    } catch (err) {
      this.appendToSession(session, {
        kind: "banner",
        text: `Could not save files next to this script (${errorMessage(err)}).`,
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
    if (!ANY_IMPORT_RE.test(code)) {
      return;
    }
    this.setSessionBusy(session, true, "Loading libraries...");
    try {
      await this.deps.runtime.ensurePackages(code);
    } catch (err) {
      const message = errorMessage(err);
      // A SyntaxError here just means the file doesn't parse; the run itself
      // will surface it. Only flag genuine load/network failures.
      if (!/syntaxerror|invalid syntax/i.test(message)) {
        this.appendToSession(session, {
          kind: "banner",
          text: `Could not load libraries (${message}). Continuing; imports may fail.`,
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
    const prefix = session.streams.stdout;
    session.streams.stdout = "";
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

  /**
   * Run the level's static checks. Returns true when findings blocked the
   * run. For a file run, `document` is set and the findings also become
   * editor diagnostics; prompt snippets keep their findings in the
   * interactions view only, since snippet lines are not file lines (they are
   * analyzed with `sessionKey` so names bound earlier in the session count as
   * existing bindings).
   */
  private async runStaticChecks(
    session: Session,
    code: string,
    fileName: string,
    level: Level,
    document: vscode.TextDocument | undefined,
  ): Promise<boolean> {
    let raw: RawStaticFinding[];
    try {
      raw = await this.deps.runtime.staticAnalyze({
        code,
        fileName,
        level,
        ...(document ? {} : { sessionKey: session.key }),
      });
    } catch (err) {
      this.feedStream(session, "stderr", `Static analysis failed: ${errorMessage(err)}\n`);
      return false;
    }
    const findings = enrichStaticFindings(raw, level, fileName);
    if (document) {
      // Also clears stale diagnostics when there are no findings.
      this.deps.diagnostics.setFindings(document.uri, document, findings);
    }
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
      text: `Static analysis found issues. ${document ? "File" : "Input"} not executed.`,
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
    if (event.kind === "stdout" || event.kind === "stderr") {
      this.feedStream(session, event.kind, event.text);
      return;
    }
    // Everything else is its own entry, so any partial line has to land first.
    this.flushStreams(session);

    switch (event.kind) {
      case "result":
        if (event.repr !== null && event.repr !== undefined) {
          this.appendToSession(session, { kind: "result", repr: event.repr });
        }
        break;
      case "image":
        this.appendToSession(session, {
          kind: "image",
          svg: event.svg,
          width: event.width,
          height: event.height,
          source: event.source ?? fileName,
        });
        break;
      case "table":
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
      case "reactor":
        this.appendToSession(session, {
          kind: "reactor",
          id: event.id,
          title: event.title,
          frame: event.frame,
          index: event.index,
          length: event.length,
          atEnd: event.atEnd,
          stopped: event.stopped,
          valueRepr: event.valueRepr,
          ticking: event.ticking,
          wantsKeys: event.wantsKeys,
          wantsMouse: event.wantsMouse,
          playing: event.ticking && !event.stopped,
          register: event.register,
          connection: event.register ? "connecting" : "none",
        });
        this.startReactor(session, event);
        break;
      case "done":
        break;
      case "testReport":
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

  /* -------- Reactors -------- */

  /**
   * Take ownership of a reactor the worker just showed.
   *
   * The clock lives here rather than in Python: a loop in the worker would
   * hold it (and the exec chain) for the whole animation, which is the
   * failure `Stop` exists for. Each tick is one short request instead, so
   * the prompt stays usable while something is animating.
   */
  private startReactor(session: Session, event: Extract<ExecutionEvent, { kind: "reactor" }>): void {
    const driver: ReactorDriver = {
      id: event.id,
      session,
      tickRate: Math.max(0.01, event.tickRate),
      ticking: event.ticking,
      playing: false,
      stopped: event.stopped,
      timer: null,
      inFlight: false,
      socket: null,
      status: "none",
      backlog: [],
    };
    this.reactors.set(event.id, driver);
    if (event.register) {
      this.connectUniverse(driver, event.register);
    }
    if (event.ticking && !event.stopped) {
      this.playReactor(driver);
    }
  }

  /* -------- Universe (world side only) -------- */

  private connectUniverse(driver: ReactorDriver, url: string): void {
    const problem = validateUniverseUrl(url);
    if (problem) {
      this.setUniverseStatus(driver, "error", problem);
      return;
    }
    this.setUniverseStatus(driver, "connecting", url);
    const handlers = {
      onOpen: () => {
        this.setUniverseStatus(driver, "open", url);
        const queued = driver.backlog;
        driver.backlog = [];
        for (const json of queued) {
          driver.socket?.send(json);
        }
      },
      onMessage: (json: string) => {
        let message: unknown;
        try {
          message = JSON.parse(json);
        } catch {
          this.setUniverseStatus(
            driver,
            "error",
            "the server sent something that is not JSON",
          );
          return;
        }
        void this.reactorEvent(driver, { kind: "receive", message });
      },
      onClose: (reason: string) => this.setUniverseStatus(driver, "closed", reason),
      onError: (message: string) => this.setUniverseStatus(driver, "error", message),
    };
    try {
      driver.socket = this.deps.connectUniverse(url, handlers);
    } catch (err) {
      driver.socket = unavailableSocket(handlers, errorMessage(err));
    }
  }

  private setUniverseStatus(
    driver: ReactorDriver,
    status: UniverseStatus,
    detail: string,
  ): void {
    driver.status = status;
    this.patchReactor(driver, { connection: status, connectionDetail: detail });
    if (status === "error") {
      this.appendToSession(driver.session, {
        kind: "banner",
        text: `Universe server: ${detail}`,
      });
    }
  }

  private sendUniverse(driver: ReactorDriver, messages: string[]): void {
    if (messages.length === 0) return;
    if (!driver.socket) {
      this.setUniverseStatus(
        driver,
        "error",
        "this reactor sent a message with package(...) but has no `register` address",
      );
      return;
    }
    if (driver.status === "open") {
      for (const json of messages) {
        driver.socket.send(json);
      }
      return;
    }
    // Still connecting: hold them, but not forever.
    for (const json of messages) {
      if (driver.backlog.length < MAX_UNIVERSE_BACKLOG) {
        driver.backlog.push(json);
      }
    }
  }

  private playReactor(driver: ReactorDriver): void {
    if (driver.playing || driver.stopped || !driver.ticking) return;
    driver.playing = true;
    driver.timer = setInterval(
      () => void this.reactorEvent(driver, { kind: "tick" }),
      driver.tickRate * 1000,
    );
    this.patchReactor(driver, { playing: true });
  }

  private pauseReactor(driver: ReactorDriver): void {
    if (driver.timer !== null) {
      clearInterval(driver.timer);
      driver.timer = null;
    }
    if (!driver.playing) return;
    driver.playing = false;
    this.patchReactor(driver, { playing: false });
  }

  /**
   * Apply one event. Frames are *dropped* rather than queued while a step is
   * in flight: a slow `to_draw` should make the animation choppy, not build
   * a backlog that outlives the program.
   */
  private async reactorEvent(driver: ReactorDriver, event: ReactorEvent): Promise<void> {
    if (driver.inFlight || !this.reactors.has(driver.id)) return;
    driver.inFlight = true;
    try {
      const result = await this.enqueue(async () => {
        const reply = await this.deps.runtime.reactorStep(driver.id, JSON.stringify(event));
        this.applyReactorResult(driver, reply);
      });
      return result;
    } catch (err) {
      this.pauseReactor(driver);
      this.feedStream(driver.session, "stderr", `Reactor error: ${errorMessage(err)}\n`);
      this.flushStreams(driver.session);
    } finally {
      driver.inFlight = false;
    }
  }

  private applyReactorResult(driver: ReactorDriver, result: ReactorStepResult): void {
    if (result.gone) {
      this.disposeReactor(driver.id, { fromPython: false });
      return;
    }
    if (!result.ok) {
      // A handler raised. Stop the clock and show it the same way any other
      // runtime error is shown, so the student sees where it happened.
      this.pauseReactor(driver);
      this.appendToSession(driver.session, {
        kind: "rawError",
        errorType: result.error_type ?? "Error",
        message: result.error_message ?? "",
        traceback: result.traceback || `${result.error_type}: ${result.error_message}`,
      });
      return;
    }
    this.patchReactor(driver, {
      frame: result.frame,
      index: result.index,
      length: result.length,
      atEnd: result.at_end,
      stopped: result.stopped,
      valueRepr: result.value_repr,
    });
    if (result.messages && result.messages.length > 0) {
      this.sendUniverse(driver, result.messages);
    }
    if (result.stopped) {
      driver.stopped = true;
      this.pauseReactor(driver);
    }
  }

  /**
   * Update a reactor's entry, and the view if that session is the one on
   * screen. Same split as `appendToSession`: the session owns the state, the
   * view is a projection of whichever session is visible.
   */
  private patchReactor(driver: ReactorDriver, patch: ReactorPatch): void {
    for (const entry of driver.session.entries) {
      if (entry.kind === "reactor" && entry.id === driver.id) {
        Object.assign(entry, patch);
        break;
      }
    }
    if (this.isActive(driver.session)) {
      this.deps.view.updateReactor(driver.id, patch);
    }
  }

  /** From the panel: play / pause / step / back / reset / scrub. */
  private handleReactorControl(id: string, action: string, index?: number): void {
    const driver = this.reactors.get(id);
    if (!driver) return;
    if (action === "play") {
      this.playReactor(driver);
      return;
    }
    if (action === "pause") {
      this.pauseReactor(driver);
      return;
    }
    if (action === "step") {
      this.pauseReactor(driver);
      void this.reactorEvent(driver, { kind: "tick" });
      return;
    }
    if (action === "back" || action === "reset" || action === "seek") {
      this.pauseReactor(driver);
      void this.seekReactor(driver, action, index);
    }
  }

  private async seekReactor(
    driver: ReactorDriver,
    action: string,
    index: number | undefined,
  ): Promise<void> {
    const target =
      action === "reset" ? 0 : action === "seek" ? (index ?? 0) : (index ?? 0);
    try {
      await this.enqueue(async () => {
        const reply = await this.deps.runtime.reactorSeek(driver.id, target);
        // Seeking never stops a reactor, it only changes which frame shows.
        this.applyReactorResult(driver, { ...reply, stopped: false });
      });
    } catch (err) {
      this.feedStream(driver.session, "stderr", `Reactor error: ${errorMessage(err)}\n`);
      this.flushStreams(driver.session);
    }
  }

  /** From the panel: a key press or mouse event over a reactor's picture. */
  private handleReactorInput(id: string, event: ReactorEvent): void {
    const driver = this.reactors.get(id);
    if (!driver || driver.stopped) return;
    void this.reactorEvent(driver, event);
  }

  private disposeReactor(id: string, opts: { fromPython: boolean }): void {
    const driver = this.reactors.get(id);
    if (!driver) return;
    this.pauseReactor(driver);
    if (driver.socket) {
      try {
        driver.socket.close();
      } catch {
        /* already gone */
      }
      driver.socket = null;
    }
    this.reactors.delete(id);
    if (opts.fromPython) {
      void this.deps.runtime.reactorDispose(id).catch(() => undefined);
    }
  }

  /** Stop and forget every reactor belonging to `session`. */
  private disposeReactorsFor(session: Session): void {
    for (const [id, driver] of [...this.reactors]) {
      if (driver.session === session) {
        this.disposeReactor(id, { fromPython: true });
      }
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
    let buf = session.streams[kind] + text;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      this.appendStreamLine(session, kind, buf.substring(0, idx));
      buf = buf.substring(idx + 1);
    }
    session.streams[kind] = buf;
  }

  private flushStreams(session: Session): void {
    for (const kind of ["stdout", "stderr"] as const) {
      const text = session.streams[kind];
      if (text.length > 0) {
        session.streams[kind] = "";
        this.appendStreamLine(session, kind, text);
      }
    }
  }

  private resetStreamBudget(session: Session): void {
    session.streamLines = 0;
    session.streamTruncated = false;
  }

  /**
   * Append one line of output, unless this run has already produced more
   * than we will render. Reports the cut-off once so output never just stops
   * without explanation, and keeps pointing at Stop, since a run that hits
   * this is usually a loop the student wants to end.
   */
  private appendStreamLine(
    session: Session,
    kind: "stdout" | "stderr",
    text: string,
  ): void {
    if (session.streamLines >= MAX_STREAM_LINES_PER_RUN) {
      if (!session.streamTruncated) {
        session.streamTruncated = true;
        this.appendToSession(session, {
          kind: "banner",
          text:
            `Output stopped after ${MAX_STREAM_LINES_PER_RUN} lines. ` +
            "If the program is still running, press Stop to end it.",
        });
      }
      return;
    }
    session.streamLines += 1;
    this.appendToSession(session, { kind, text });
  }
}

/** An event to feed a reactor; mirrors `Reactor.react` in reactorLib.py. */
type ReactorEvent =
  | { kind: "tick" }
  | { kind: "key"; key: string }
  | { kind: "mouse"; x: number; y: number; event: string }
  | { kind: "receive"; message: unknown };

interface ReactorPatch {
  connection?: UniverseStatus;
  connectionDetail?: string;
  frame?: { data: string; width: number; height: number };
  index?: number;
  length?: number;
  atEnd?: boolean;
  stopped?: boolean;
  valueRepr?: string;
  playing?: boolean;
}

/**
 * Most messages a world may queue before its socket opens. A world that
 * sends on every tick to a server that never answers would otherwise grow
 * this without bound.
 */
const MAX_UNIVERSE_BACKLOG = 100;

interface ReactorDriver {
  id: string;
  session: Session;
  socket: UniverseSocket | null;
  status: UniverseStatus;
  /** Sent once the socket opens. */
  backlog: string[];
  /** Seconds between ticks, floored so a typo cannot busy-loop the host. */
  tickRate: number;
  ticking: boolean;
  playing: boolean;
  stopped: boolean;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function displayName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.toString();
}
