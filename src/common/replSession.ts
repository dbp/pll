import * as vscode from "vscode";
import { serializeFinding } from "./analyzers/findingLocation";
import type { Diagnostics } from "./diagnostics";
import {
  type InteractionsView,
  type Entry,
  type PromptKind,
  type ReactorPatch,
  type SessionDisplayState,
} from "./interactionsView";
import { DEFAULT_LEVEL, LEVEL_BEGINNER, parseLevel, type Level } from "./level";
import type { BundleStore } from "./examplarSource";
import { ReactorController, type ProgramInfo, type ReactorEvent } from "./reactorController";
import { runFilePlan, runInputPlan, type RunHost, type RunSummary } from "./runPlan";
import type { ExecutionEvent, PythonRuntime } from "./types";
import type { UniverseConnect } from "./universeClient";
import { collectSiblingFiles, folderUri, writeBackSiblingFiles } from "./workspaceFiles";
import { isProgramDocument } from "./programDocuments";
import type { Selection } from "./workspaceFilePolicy";
import { errorText } from "./errorText";
import { PythonLostError } from "./runtimeErrors";

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
 * evaluations are independent. It lasts until its file is closed.
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
  /**
   * URI of the underlying document, used for diagnostics + open-location;
   * null for the session with no file.
   */
  documentUri: vscode.Uri | null;
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
   * Language level of the most recent Run File on this session - always
   * `beginner` for the session with no file. `null` until the file has been
   * run at least once. We surface this in the header (e.g. `hello.py
   * [beginner]`) so it's easy to tell which rule set is currently in effect
   * after a run.
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
  /** Other files a run put a finding on, for the next run to clear. */
  otherDiagnosed: vscode.Uri[];
}

/**
 * The session with no file, for prompt lines typed before there is a file to
 * type them in - on the web, before there is a repository to make one in.
 * Its key is no document's URI.
 */
const NO_FILE_KEY = "pll:no-file";
const NO_FILE_TITLE = "No file";

/**
 * Routes user input + run-file events to the correct per-file session and
 * keeps the interactions view showing whichever session corresponds to the
 * active Python editor - or, with none, the session with no file. Owns the
 * single Pyodide exec chain.
 */
export class ReplSession implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  /** Currently-shown session key, or null before the first is shown. */
  private activeKey: string | null = null;

  /**
   * Every run - a file, a prompt line, a reactor's step or seek - is queued
   * here, so one finishes before the next starts and their output cannot
   * interleave. What runs none of the student's code stays off it: starting
   * Python, a Stop (which has to reach the run in progress), asking whether
   * a prompt line is complete yet, and discarding a reactor.
   */
  private execChain: Promise<void> = Promise.resolve();

  private initialized = false;
  private initPromise: Promise<boolean> | null = null;
  /** Why Pyodide failed to start, if it did. */
  private initError: string | null = null;

  private readonly editorWatcher: vscode.Disposable;
  private readonly closeWatcher: vscode.Disposable;

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
      output: (session, event, program) => this.handleEvent(session, event, program),
      enqueue: (task) => this.enqueue(task),
    });
    deps.view.setHandlers({
      onSubmit: (code) => this.handleSubmit(code),
      onInterrupt: () => this.handleInterrupt(),
      onClearRequested: () => this.handleClearRequested(),
      onReactorControl: (id, action, index) => this.reactors.control(id, action, index),
      onReactorInput: (id, event) => this.reactors.input(id, event as ReactorEvent),
      onOpenLocation: (fileName, line, column) => void this.openLocation(fileName, line, column),
      onViewReady: () => {
        const session = this.activeSession();
        if (session) this.deps.view.showSession(this.displayStateOf(session));
      },
    });
    deps.runtime.setStdinHandler(() => this.provideStdin());
    deps.runtime.setPythonLostHandler(() => this.handlePythonLost());

    // Keep the visible session in sync with the active editor.
    this.editorWatcher = vscode.window.onDidChangeActiveTextEditor((editor) =>
      this.handleActiveEditorChange(editor),
    );
    // Pick up the editor that's already active at activation time (the
    // common case when the extension activates via `onLanguage:python`).
    this.handleActiveEditorChange(vscode.window.activeTextEditor);
    if (this.activeKey === null) {
      this.setActive(this.noFileSession().key);
    }
    this.closeWatcher = vscode.workspace.onDidCloseTextDocument((document) =>
      this.handleDocumentClosed(document),
    );

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

  /** Show the session with no file, whatever file is open. */
  showNoFileSession(): void {
    this.setActive(this.noFileSession().key);
    void this.deps.view.reveal({ preserveFocus: false });
  }

  /**
   * Stop whatever the visible session is running. Same behavior as Ctrl+C in
   * the interactions panel, reachable from the command palette and the
   * panel's Stop button.
   */
  stopActiveProgram(): void {
    this.handleInterrupt();
  }

  /**
   * Clear the visible session - its entries and its reactors' clocks, not
   * just the panel, or the entries would come back with the session and a
   * reactor tick on with no card. The panel's Clear button and **PLL: Clear
   * Interactions** both come here.
   */
  clearActiveSession(): void {
    this.handleClearRequested();
  }

  dispose(): void {
    this.reactors.disposeAll();
    this.editorWatcher.dispose();
    this.closeWatcher.dispose();
  }

  /* -------- Init -------- */

  private async ensureInitialized(): Promise<boolean> {
    if (this.initPromise) return this.initPromise;
    // A fresh attempt is loading again, whatever the last one said.
    this.initError = null;
    // Surface "Loading..." status on the active session (if any).
    this.refreshActiveBusy();
    this.initPromise = (async () => {
      try {
        await this.deps.runtime.initialize();
      } catch (err) {
        this.initError = errorText(err);
        // Not remembered, so the next run tries again rather than reporting
        // this failure until the window is reloaded.
        this.initPromise = null;
        return false;
      }
      this.initialized = true;
      this.initError = null;
      this.refreshActiveBusy();
      return true;
    })();
    return this.initPromise;
  }

  /**
   * Record a failed Pyodide start in the session's own log - per attempt,
   * since each run tries again: the eager warm-up in the constructor has no
   * session to report against, and a later Run File clears the stream before
   * it asks.
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
    if (editor.document.languageId !== "python" || !isProgramDocument(editor.document.uri)) return;
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

  /**
   * Python stopped completely and the next run starts a new one, so every
   * file's names are gone, and every reactor's state. Said in each file
   * that has run - not only the one whose run was going - or that file's
   * next prompt line would fail with a NameError and no reason why.
   */
  private handlePythonLost(): void {
    this.reactors.disposeAll();
    for (const session of this.sessions.values()) {
      if (session.runSeq === 0) continue;
      this.flushStreams(session);
      this.appendToSession(session, {
        kind: "banner",
        text:
          "Python stopped completely, so the next run starts a new one. " +
          (session.documentUri === null
            ? "Everything defined here is gone."
            : "Everything this file defined is gone; run it again to define it."),
      });
    }
  }

  /**
   * A file's session ends when the file is closed: its entries, its
   * reactors, and the names its runs defined. Without this, every file
   * opened in a window kept all of them until the window closed.
   *
   * Queued, so a run of the file still finishes first, and checked again
   * when its turn comes: VS Code closes and reopens a document whose
   * language mode is changed, and that file is still open.
   */
  private handleDocumentClosed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    if (!this.sessions.has(key)) return;
    void this.enqueue(async () => {
      const session = this.sessions.get(key);
      if (!session || vscode.workspace.textDocuments.some((d) => d.uri.toString() === key)) {
        return;
      }
      this.reactors.disposeAllFor(session);
      this.sessions.delete(key);
      this.stopPending.delete(key);
      if (this.activeKey === key) {
        this.activeKey = null;
        this.setActive(this.noFileSession().key);
      }
      await this.deps.runtime.endSession(key).catch(() => undefined);
    });
  }

  private setActive(key: string): void {
    if (this.activeKey === key) return;
    const previous = this.activeSession();
    if (previous) {
      this.reactors.suspendAllFor(previous);
    }
    this.activeKey = key;
    const session = this.sessions.get(key);
    if (!session) return;
    this.deps.view.showSession(this.displayStateOf(session));
    this.resumeReactors(session);
  }

  /**
   * Play again the reactors that were playing when `session`'s file was
   * left - with its own files mounted first, for a handler that opens one:
   * another file's run may have mounted that file's. Queued, so the mount
   * comes before the first tick.
   */
  private resumeReactors(session: Session): void {
    if (!this.reactors.hasAny(session)) return;
    void this.enqueue(async () => {
      try {
        await this.deps.runtime.mountWorkspaceFiles((await this.filesBeside(session)).files);
      } catch {
        /* the reactor still runs; a file it opens may be missing */
      }
    });
    this.reactors.resumeAllFor(session);
  }

  /** Everything the view needs to show `session` from scratch. */
  private displayStateOf(session: Session): SessionDisplayState {
    return {
      title: this.titleFor(session),
      entries: session.entries,
      prompt: session.prompt,
      busy: this.computeVisibleBusy(session),
      status: this.visibleStatus(session),
      awaitingInput: this.stdinPending?.session === session,
      inputPrefix: this.stdinPending?.session === session ? this.stdinPending.prefix : "",
    };
  }

  /* -------- Session bookkeeping -------- */

  private getOrCreateSession(uri: vscode.Uri, fileName: string): Session {
    return this.sessions.get(uri.toString()) ?? this.addSession(uri.toString(), fileName, uri, null);
  }

  /** The session with no file, made the first time it is wanted. */
  private noFileSession(): Session {
    return this.sessions.get(NO_FILE_KEY) ?? this.addSession(NO_FILE_KEY, NO_FILE_TITLE, null, LEVEL_BEGINNER);
  }

  private addSession(key: string, fileName: string, uri: vscode.Uri | null, level: Level | null): Session {
    const session: Session = {
      key,
      fileName,
      documentUri: uri,
      entries: [],
      streams: { stdout: "", stderr: "" },
      prompt: "primary",
      busy: false,
      continuationLines: [],
      continuing: false,
      lastLevel: level,
      runSeq: 0,
      stopRequestedSeq: -1,
      streamLines: 0,
      streamTruncated: false,
      otherDiagnosed: [],
    };
    this.sessions.set(key, session);
    return session;
  }

  /** The files a run of `session` sees: those beside its file, and none without one. */
  private filesBeside(session: Session): Promise<Selection> {
    return session.documentUri === null
      ? Promise.resolve({ files: [], leftOut: [] })
      : collectSiblingFiles(session.documentUri);
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

  /**
   * Open a location an entry names. It belongs to the session showing it:
   * its own file, or one beside it - a helper module it imports. Resolved
   * here rather than by bare name, which opened the wrong `main.py` when
   * two folders had one.
   */
  private async openLocation(fileName: string, line: number, column: number | null): Promise<void> {
    const session = this.activeSession();
    if (!session || session.documentUri === null) return;
    const folder = folderUri(session.documentUri);
    const uri =
      fileName === session.fileName
        ? session.documentUri
        : folder !== undefined
          ? vscode.Uri.joinPath(folder, fileName)
          : null;
    if (uri === null) return;
    // `line` is 1-based and `column` 0-based, as a finding's location is.
    const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column ?? 0));
    try {
      await vscode.window.showTextDocument(uri, {
        selection: new vscode.Range(position, position),
        preserveFocus: false,
      });
    } catch {
      /* the file is not there to open */
    }
  }

  /**
   * Clear the panel. With no file to run again, the session with no file
   * also forgets what was typed in it, or a name set once at `beginner`
   * could never be set again.
   */
  private handleClearRequested(): void {
    const session = this.activeSession();
    if (!session) return;
    this.clearSession(session);
    if (session.documentUri !== null) return;
    session.continuationLines = [];
    session.continuing = false;
    this.setSessionPrompt(session, "primary");
    void this.enqueue(async () => {
      await this.deps.runtime.endSession(session.key).catch(() => undefined);
      this.appendToSession(session, {
        kind: "banner",
        text: "Started afresh: nothing typed here before is defined now.",
      });
    });
  }

  /* -------- Submission flow (matches CPython's interactive shell) -------- */

  private async processSubmission(session: Session, rawCode: string): Promise<void> {
    if (!this.initialized && !(await this.ensureInitialized())) {
      this.reportInitFailure(session);
      return;
    }
    const lines = rawCode.split(/\r?\n/);
    if (lines.length > 1 && !session.continuing) {
      return this.processBlock(session, rawCode);
    }
    for (const line of lines) {
      await this.processLine(session, line);
    }
  }

  /**
   * Several lines submitted at once - written with Shift+Enter, or pasted -
   * are one input, as Python 3.13's own shell takes a paste: a blank line
   * inside a function does not end it. Unfinished, it waits for more as a
   * continuation; otherwise it runs whole, errors and all.
   */
  private async processBlock(session: Session, rawCode: string): Promise<void> {
    const block = rawCode.replace(/\s+$/, "");
    const lines = block.split(/\r?\n/);
    lines.forEach((line, i) => {
      this.appendToSession(session, { kind: "echo", prompt: i === 0 ? ">>>" : "...", code: line });
    });
    if (block.trim() === "") return;
    const status = await this.deps.runtime.checkReplComplete(block, true);
    if (status.status === "incomplete") {
      session.continuationLines.push(...lines);
      session.continuing = true;
      this.setSessionPrompt(session, "continuation");
      return;
    }
    return this.runSnippet(session, block);
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
   * Run a prompt line, at the level of the file's last run - or, before
   * its first, of its `#level` line. The steps - packages, sibling files,
   * the checks, the run - are `runInputPlan`'s.
   */
  private async executeRepl(session: Session, code: string): Promise<void> {
    const level = session.lastLevel ?? this.headerLevel(session);
    session.runSeq += 1;
    this.resetStreamBudget(session);
    this.setSessionBusy(session, true, "Starting...");
    const program = { source: code, fileName: "<repl>", level };
    await this.runWithSession(session, program, undefined, (host) =>
      runInputPlan(this.deps.runtime, host, { code, sessionKey: session.key, level }),
    );
  }

  /** The level the `#level` line of `session`'s file names, as it is in the editor. */
  private headerLevel(session: Session): Level {
    const uri = session.documentUri?.toString();
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    return document ? parseLevel(document.getText()) : DEFAULT_LEVEL;
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
    for (const uri of session.otherDiagnosed.splice(0)) {
      this.deps.diagnostics.clear(uri);
    }

    if (!this.initialized && !(await this.ensureInitialized())) {
      this.reportInitFailure(session);
      this.flushStreams(session);
      this.setSessionBusy(session, false);
      return;
    }
    // Re-post the status: until init finished it read "Loading Python...".
    this.setSessionBusy(session, true, "Starting...");
    // The level is the plan's to read; `level` below hears it.
    const program = { source: code, fileName, level: DEFAULT_LEVEL };
    await this.runWithSession(session, program, document, (host) =>
      runFilePlan(this.deps.runtime, host, {
        code,
        fileName,
        sessionKey: session.key,
        runTests: true,
        bundles: this.deps.bundleStore,
      }),
    );
  }

  /**
   * Run `plan` with this session as its host, and leave the session idle
   * after, whatever happened. A failure of PLL's own is shown in the
   * session's stderr rather than thrown.
   */
  private async runWithSession(
    session: Session,
    program: ProgramInfo,
    document: vscode.TextDocument | undefined,
    plan: (host: RunHost) => Promise<RunSummary>,
  ): Promise<void> {
    try {
      await plan(this.hostFor(session, program, document));
    } catch (err) {
      // Python stopping is said in every session, by `handlePythonLost`.
      if (!(err instanceof PythonLostError)) {
        this.feedStream(session, "stderr", `Internal error: ${errorText(err)}\n`);
      }
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
    let shown = program;
    const entry = (item: Entry) => {
      // Anything that is its own entry lands after the output before it.
      this.flushStreams(session);
      this.appendToSession(session, item);
    };
    return {
      level: (level) => {
        // Recorded first, so the header and the prompt line's level reflect
        // it even when the checks stop the run.
        shown = { ...shown, level };
        session.lastLevel = level;
        if (this.isActive(session)) {
          this.deps.view.setTitle(this.titleFor(session));
        }
      },
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
        if (!document) return;
        if (finding.fileName === session.fileName) {
          this.deps.diagnostics.setFinding(document.uri, document, finding);
          return;
        }
        // In another of the student's files, next to this one.
        const folder = folderUri(document.uri);
        if (folder === undefined) return;
        const uri = vscode.Uri.joinPath(folder, finding.fileName);
        const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        this.deps.diagnostics.setFinding(uri, open, finding);
        session.otherDiagnosed.push(uri);
      },
      event: (event) => this.handleEvent(session, event, shown),
      say: (text) => entry({ kind: "banner", text }),
      status: (text) => this.setSessionBusy(session, true, text),
      stopRequested: () => session.stopRequestedSeq === runSeq,
      siblingFiles: () => this.filesBeside(session),
      writeBack: async (files) => {
        if (session.documentUri !== null) {
          return writeBackSiblingFiles(session.documentUri, files);
        }
        entry({
          kind: "banner",
          text: `Not saved: ${files.map((f) => f.name).join(", ")}. With no file open, there is no folder to save it in.`,
        });
        return { written: [], leftOut: [] };
      },
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
    }
    // Through the session, not just the view, or the session's own status
    // would still say "Waiting for input..." when its file is shown again.
    this.setSessionBusy(pending.session, true, "Running...");
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
   * without explanation, and says how to end what is printing: usually a
   * loop, which Stop ends - or a reactor's handlers, which print after its
   * run is over, so that Stop has nothing to stop and Pause is the answer.
   */
  private appendStreamLine(
    session: Session,
    kind: "stdout" | "stderr",
    text: string,
  ): void {
    if (session.streamLines >= MAX_STREAM_LINES_PER_RUN) {
      if (!session.streamTruncated) {
        session.streamTruncated = true;
        const reactor = !session.busy && this.reactors.anyPlaying(session);
        this.appendToSession(session, {
          kind: "banner",
          text:
            `Output stopped after ${MAX_STREAM_LINES_PER_RUN} lines. ` +
            (reactor
              ? "The reactor is still running; press Pause on it to stop it."
              : "If the program is still running, press Stop to end it."),
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
