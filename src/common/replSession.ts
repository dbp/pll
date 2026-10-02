import * as vscode from "vscode";
import { serializeFinding } from "./analyzers/findingLocation";
import type { Diagnostics } from "./diagnostics";
import {
  type InteractionsView,
  type Entry,
  type PromptKind,
  type ReactorPatch,
} from "./interactionsView";
import { DEFAULT_LEVEL, parseLevel, type Level } from "./level";
import type { BundleStore } from "./examplarSource";
import { ReactorController, type ProgramInfo, type ReactorEvent } from "./reactorController";
import { runFilePlan, runInputPlan, type RunHost, type RunOutcome } from "./runPlan";
import type { ExecutionEvent, PythonRuntime } from "./types";
import type { UniverseConnect } from "./universeClient";
import { collectSiblingFiles, folderUri, writeBackSiblingFiles } from "./workspaceFiles";
import { errorText } from "./errorText";

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
  /** Where fetched Examplar bundles are cached between runs. */
  bundleStore: BundleStore;
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
  /**
   * The `runSeq` of the run Stop was last pressed in. A run has several
   * steps - for a file: the checks, loading, Examplar, the tests and the
   * program - and a Stop ends all of them, not just the one it lands in:
   * the run checks this between them.
   */
  stopRequestedSeq: number;
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
  /** The reactors runs have shown, and their clocks and sockets. */
  private readonly reactors: ReactorController<Session>;
  private stdinPending: {
    session: Session;
    prefix: string;
    resolve: (line: string | null) => void;
  } | null = null;

  constructor(private readonly deps: ReplDeps) {
    this.reactors = new ReactorController<Session>({
      runtime: deps.runtime,
      connectUniverse: deps.connectUniverse,
      append: (session, entry) => {
        this.flushStreams(session);
        this.appendToSession(session, entry);
      },
      patch: (session, id, patch) => this.patchReactorEntry(session, id, patch),
      enqueue: (task) => this.enqueue(task),
    });
    deps.view.setHandlers({
      onSubmit: (code) => this.handleSubmit(code),
      onInterrupt: () => this.handleInterrupt(),
      onClearRequested: () => this.handleClearRequested(),
      onReactorControl: (id, action, index) => this.reactors.control(id, action, index),
      onReactorInput: (id, event) => this.reactors.input(id, event as ReactorEvent),
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
    this.reactors.disposeAll();
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
        this.initError = errorText(err);
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
        stopRequestedSeq: -1,
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
    this.reactors.disposeAllFor(session);
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
    session.stopRequestedSeq = session.runSeq;
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
  private async executeRepl(session: Session, code: string): Promise<void> {
    const level = session.lastLevel ?? DEFAULT_LEVEL;
    session.runSeq += 1;
    this.resetStreamBudget(session);
    this.setSessionBusy(session, true, "Starting...");
    const program = { source: code, fileName: "<repl>", level };
    await this.runWithSession(session, program, undefined, (host) =>
      runInputPlan(this.deps.runtime, host, { code, sessionKey: session.key, level }),
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
    const program = { source: code, fileName, level };
    await this.runWithSession(session, program, document, (host) =>
      runFilePlan(this.deps.runtime, host, {
        code,
        fileName,
        sessionKey: session.key,
        level,
        runTests: true,
        bundles: this.deps.bundleStore,
      }),
    );
  }

  /**
   * Run `plan` with this session as its host, and leave the session idle
   * after, whatever happened.
   */
  private async runWithSession(
    session: Session,
    program: ProgramInfo,
    document: vscode.TextDocument | undefined,
    plan: (host: RunHost) => Promise<RunOutcome>,
  ): Promise<void> {
    try {
      await plan(this.hostFor(session, program, document));
    } catch (err) {
      this.feedStream(session, "stderr", `Internal error: ${errorText(err)}\n`);
    } finally {
      this.flushStreams(session);
      this.setSessionBusy(session, false);
    }
  }

  /** How a run plan shows things in this session's panel. */
  private hostFor(
    session: Session,
    program: ProgramInfo,
    document: vscode.TextDocument | undefined,
  ): RunHost {
    const runSeq = session.runSeq;
    const entry = (item: Entry) => {
      // Anything that is its own entry lands after the output before it.
      this.flushStreams(session);
      this.appendToSession(session, item);
    };
    return {
      staticFindings: (findings) => {
        if (document) {
          // Also clears stale diagnostics when there are no findings.
          this.deps.diagnostics.setFindings(document.uri, document, findings);
        }
        for (const finding of findings) {
          entry({ kind: "finding", finding: serializeFinding(finding) });
        }
      },
      runtimeFinding: (finding) => {
        entry({ kind: "finding", finding: serializeFinding(finding) });
        if (document) {
          this.deps.diagnostics.setFinding(document.uri, document, finding);
        }
      },
      event: (event) => this.handleEvent(session, event, program),
      say: (text) => entry({ kind: "banner", text }),
      status: (text) => this.setSessionBusy(session, true, text),
      stopRequested: () => session.stopRequestedSeq === runSeq,
      siblingFiles: async () =>
        folderUri(session.documentUri) ? collectSiblingFiles(session.documentUri) : [],
      writeBack: async (files) =>
        folderUri(session.documentUri) ? writeBackSiblingFiles(session.documentUri, files) : [],
      examplarCard: (card) => entry(card),
      aroundProgram: async (run) => {
        this.stdinSession = session;
        try {
          await run();
        } finally {
          this.stdinSession = null;
          this.cancelStdin();
        }
      },
    };
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

  /* -------- Event handling -------- */

  /**
   * Show one event of a run. Errors never get here - the run plan turns
   * them into findings - and test reports arrive already explained.
   */
  private handleEvent(session: Session, event: ExecutionEvent, program: ProgramInfo): void {
    const { fileName } = program;
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
      case "table":
        this.appendToSession(session, { ...event, source: event.source ?? fileName });
        break;
      case "reactor": {
        // The card is the event, plus the state the host drives from here.
        const { tickRate: _tickRate, ...shown } = event;
        this.appendToSession(session, {
          ...shown,
          playing: event.ticking && !event.stopped,
          connection: event.register ? "connecting" : "none",
        });
        this.reactors.start(session, event, program);
        break;
      }
      case "done":
        break;
      case "testReport":
        this.appendToSession(session, event);
        break;
    }
  }

  /* -------- Examplar -------- */

  /* -------- Reactors -------- */

  /** Update a reactor's card in `session`, and in the view if it is showing. */
  private patchReactorEntry(session: Session, id: string, patch: ReactorPatch): void {
    // Same split as `appendToSession`: the session owns the state, the
    // view is a projection of whichever session is visible.
    for (const entry of session.entries) {
      if (entry.kind === "reactor" && entry.id === id) {
        Object.assign(entry, patch);
        break;
      }
    }
    if (this.isActive(session)) {
      this.deps.view.updateReactor(id, patch);
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

function displayName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.toString();
}
