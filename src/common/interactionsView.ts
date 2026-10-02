import * as vscode from "vscode";
import type { SerializedFinding } from "./analyzers/findingLocation";
import type { ExamplarEntry } from "./examplarPhase";
import type { ExecutionImageChunk, ExecutionTableChunk, ExecutionTestReportChunk } from "./types";
import type { UniverseStatus } from "./universeClient";

/**
 * The PLL interactions view replaces both the pseudoterminal REPL and the
 * standalone image view: it is a single webview that displays banners, user
 * echoes, stdout/stderr, results, images, and structured errors as a stream,
 * with an input row at the bottom for new REPL submissions.
 *
 * Sessions
 * --------
 * The view itself is unaware of sessions; the session manager owns one
 * `Session` per Python file and uses `showSession({entries, prompt, busy})`
 * to swap which session's content is visible. Per-session incremental
 * updates go through the regular `append` / `setBusy` / `setPrompt` /
 * `clear` methods, but the session manager only calls those for the
 * currently-displayed session.
 *
 * Empty mode
 * ----------
 * Until a Python file has been active in the workspace, the view shows a
 * placeholder message and hides the input row. `showSession(...)` switches
 * out of that mode.
 */

/* -------------------------------------------------------------- */
/* Entry types (serializable; sent to the webview as JSON).        */
/* -------------------------------------------------------------- */

export type Entry =
  | BannerEntry
  | EchoEntry
  | StreamTextEntry
  | ResultEntry
  | ImageEntry
  | TableEntry
  | FindingEntry
  | RawErrorEntry
  | ReactorEntry
  | ExamplarEntry
  | TestReportEntry;

export interface BannerEntry {
  kind: "banner";
  text: string;
}
export interface EchoEntry {
  kind: "echo";
  prompt: ">>>" | "...";
  code: string;
}
export interface StreamTextEntry {
  kind: "stdout" | "stderr";
  text: string;
}
export interface ResultEntry {
  kind: "result";
  repr: string;
}
/** An image, a table or a test report is shown as the event it arrived as. */
export type ImageEntry = ExecutionImageChunk;
export type TableEntry = ExecutionTableChunk;
export type TestReportEntry = ExecutionTestReportChunk;
export interface FindingEntry {
  kind: "finding";
  finding: SerializedFinding;
}
/**
 * PLL itself failing - Python would not start - shown as it is. Never a
 * program's error: every one of those is explained, as a `FindingEntry`.
 */
export interface RawErrorEntry {
  kind: "rawError";
  errorType: string;
  message: string;
  traceback: string;
}

/**
 * A reactor's card. Unlike every other entry this one is *live*: the host
 * keeps patching it as frames arrive, and it sends controls and input back.
 */
export interface ReactorEntry {
  kind: "reactor";
  id: string;
  title: string;
  frame: { data: string; width: number; height: number };
  /** Frame number being shown, and how many have been recorded. */
  index: number;
  length: number;
  /** Whether the shown frame is the latest one (vs. rewound). */
  atEnd: boolean;
  stopped: boolean;
  /** `repr()` of the current state, shown under the picture. */
  valueRepr: string;
  ticking: boolean;
  wantsKeys: boolean;
  wantsMouse: boolean;
  playing: boolean;
  /** Universe server this world is registered with, if any. */
  register: string | null;
  connection: UniverseStatus;
  /** Why the connection is in that state, when there is something to say. */
  connectionDetail?: string;
}

/** Fields of a `ReactorEntry` the host may update in place. */
export type ReactorPatch = Partial<Omit<ReactorEntry, "kind" | "id" | "title">>;

export type PromptKind = "primary" | "continuation";

/* -------------------------------------------------------------- */
/* Host-side message types                                         */
/* -------------------------------------------------------------- */

interface HostMessageAppend {
  type: "append";
  entry: Entry;
}
interface HostMessageAppendMany {
  type: "appendMany";
  entries: Entry[];
}
interface HostMessageReactorPatch {
  type: "reactorPatch";
  id: string;
  patch: ReactorPatch;
}
interface HostMessageClear {
  type: "clear";
}
interface HostMessagePrompt {
  type: "prompt";
  kind: PromptKind;
}
interface HostMessageBusy {
  type: "busy";
  busy: boolean;
  status?: string;
}
interface HostMessageAwaitingInput {
  type: "awaitingInput";
  awaiting: boolean;
  prefix?: string;
}
interface HostMessageReplay {
  type: "replay";
  mode: "session";
  title: string;
  entries: Entry[];
  prompt: PromptKind;
  busy: boolean;
  status?: string;
  awaitingInput?: boolean;
  inputPrefix?: string;
}
interface HostMessageEmpty {
  type: "empty";
  message: string;
}
interface HostMessageTitle {
  type: "title";
  title: string;
}
interface HostMessageFocus {
  type: "focusInput";
}
type HostToView =
  | HostMessageAppend
  | HostMessageAppendMany
  | HostMessageReactorPatch
  | HostMessageClear
  | HostMessagePrompt
  | HostMessageBusy
  | HostMessageAwaitingInput
  | HostMessageReplay
  | HostMessageEmpty
  | HostMessageTitle
  | HostMessageFocus;

export interface SessionDisplayState {
  /** Header title shown at the top of the view (typically the file name). */
  title: string;
  entries: ReadonlyArray<Entry>;
  prompt: PromptKind;
  busy: boolean;
  status?: string;
  awaitingInput?: boolean;
  inputPrefix?: string;
}

/* -------------------------------------------------------------- */
/* View -> host callbacks                                          */
/* -------------------------------------------------------------- */

export interface InteractionsHandlers {
  onSubmit(code: string): void;
  onInterrupt(): void;
  onClearRequested(): void;
  /** play / pause / step / back / reset / seek on a reactor card. */
  onReactorControl(id: string, action: string, index?: number): void;
  /** A key press or mouse event over a reactor's picture. */
  onReactorInput(id: string, event: unknown): void;
}

/**
 * How long appends may wait to be sent as one batch.
 *
 * Every message to a webview costs an IPC hop, and the view then persists
 * its state and scrolls per message. A program printing in a loop produced
 * one of each per line, which starved the extension host badly enough that
 * a Stop click took ~17 seconds to be processed. One frame of latency is
 * imperceptible for interactive output and collapses a burst into a single
 * message.
 */
const APPEND_FLUSH_MS = 16;

const VIEW_ID = "pllInteractionsView";

export class InteractionsView
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = VIEW_ID;

  private view: vscode.WebviewView | null = null;
  private webviewReady = false;
  private readonly disposables: vscode.Disposable[] = [];

  // Mirror of what is currently displayed (always the active session, or
  // an "empty" placeholder when no Python file is active). The session
  // manager keeps the per-session authoritative state; this is just what
  // the view will show on reload.
  private mode: "session" | "empty" = "empty";
  private emptyMessage = "Open a Python file to start an interactions session.";
  private title = "";
  private entries: Entry[] = [];
  private prompt: PromptKind = "primary";
  private busy = false;
  private status: string | undefined = undefined;
  private awaitingInput = false;
  private inputPrefix = "";

  // Map of display fileName -> document URI, used to honor click-to-open
  // requests coming from the webview's error-location links.
  private readonly fileMap = new Map<string, vscode.Uri>();

  // Appends waiting to be sent as one `appendMany`.
  private pendingAppends: Entry[] = [];
  private appendTimer: ReturnType<typeof setTimeout> | null = null;

  // Optional callbacks - the session manager installs these.
  private handlers: InteractionsHandlers | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setHandlers(handlers: InteractionsHandlers): void {
    this.handlers = handlers;
  }

  /** Tell the view that `displayName` (as it appears in error locations)
   *  corresponds to the given URI; clicking such a link will open it. */
  registerFile(displayName: string, uri: vscode.Uri): void {
    this.fileMap.set(displayName, uri);
  }

  /* -------- Session swapping -------- */

  /**
   * Replace the visible state with the given session's. Called by the
   * session manager when the active editor changes to a different Python
   * file (or when the very first Python session becomes active).
   */
  showSession(state: SessionDisplayState): void {
    this.mode = "session";
    // The replay carries every entry, so anything queued is already in it.
    this.dropPendingAppends();
    this.title = state.title;
    this.entries = [...state.entries];
    this.prompt = state.prompt;
    this.busy = state.busy;
    this.status = state.status;
    this.awaitingInput = state.awaitingInput ?? false;
    this.inputPrefix = state.inputPrefix ?? "";
    this.post(this.replayMessage());
  }

  /** Update the header title without otherwise changing state. */
  setTitle(title: string): void {
    if (this.mode !== "session") return;
    this.title = title;
    this.post({ type: "title", title });
  }

  /* -------- Top-level operations the session manager calls -------- */
  /* These all assume the addressed session is the active one. The
   * session manager is responsible for not calling them for inactive
   * sessions. */

  append(entry: Entry): void {
    if (this.mode !== "session") return;
    this.entries.push(entry);
    this.pendingAppends.push(entry);
    if (this.appendTimer === null) {
      this.appendTimer = setTimeout(() => this.flushAppends(), APPEND_FLUSH_MS);
    }
  }

  /**
   * Patch a live reactor card in place. Sent immediately rather than through
   * the append batch: a frame supersedes the previous frame, so batching
   * them would only mean showing stale ones.
   */
  updateReactor(id: string, patch: ReactorPatch): void {
    if (this.mode !== "session") return;
    for (const entry of this.entries) {
      if (entry.kind === "reactor" && entry.id === id) {
        Object.assign(entry, patch);
        break;
      }
    }
    this.post({ type: "reactorPatch", id, patch });
  }

  clear(): void {
    if (this.mode !== "session") return;
    this.entries = [];
    // Queued appends belong to entries that no longer exist; sending them
    // after a clear would resurrect them.
    this.dropPendingAppends();
    this.post({ type: "clear" });
  }

  setPrompt(kind: PromptKind): void {
    if (this.mode !== "session") return;
    this.prompt = kind;
    this.post({ type: "prompt", kind });
  }

  setBusy(busy: boolean, status?: string): void {
    if (this.mode !== "session") return;
    this.busy = busy;
    this.status = status;
    if (!busy) {
      this.awaitingInput = false;
      this.inputPrefix = "";
    }
    this.post({ type: "busy", busy, status });
    if (!busy) {
      this.post({ type: "awaitingInput", awaiting: false });
    }
  }

  /**
   * While a file is running, `input()` needs the prompt row enabled even
   * though the session is busy. `prefix` is any unflushed stdout (the
   * `input("Choice: ")` prompt) shown next to the textarea.
   */
  setAwaitingInput(awaiting: boolean, prefix?: string): void {
    if (this.mode !== "session") return;
    this.awaitingInput = awaiting;
    this.inputPrefix = awaiting ? (prefix ?? "") : "";
    this.post({
      type: "awaitingInput",
      awaiting,
      prefix: this.inputPrefix,
    });
  }

  /** Reveal the view (creating it if necessary). */
  async reveal(options: { preserveFocus?: boolean } = {}): Promise<void> {
    if (this.view) {
      this.view.show?.(options.preserveFocus ?? false);
      return;
    }
    try {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    } catch {
      /* container not yet present */
    }
  }

  focusInput(): void {
    this.post({ type: "focusInput" });
  }

  /* -------- WebviewViewProvider -------- */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.renderHtml(view.webview);

    this.disposables.push(
      view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg)),
      view.onDidDispose(() => {
        this.view = null;
        this.webviewReady = false;
      }),
    );
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as {
      type?: string;
      code?: string;
      svg?: string;
      csv?: string;
      source?: string;
      fileName?: string;
      line?: number;
      column?: number;
      id?: string;
      action?: string;
      index?: number;
      event?: unknown;
    };
    switch (m.type) {
      case "ready":
        this.webviewReady = true;
        if (this.mode === "session") {
          this.post(this.replayMessage());
        } else {
          this.post({ type: "empty", message: this.emptyMessage });
        }
        break;
      case "submit":
        if (typeof m.code === "string" && this.handlers) {
          this.handlers.onSubmit(m.code);
        }
        break;
      case "interrupt":
        this.handlers?.onInterrupt();
        break;
      case "clearRequested":
        this.handlers?.onClearRequested();
        break;
      case "reactorControl":
        if (typeof m.id === "string" && typeof m.action === "string") {
          this.handlers?.onReactorControl(m.id, m.action, m.index);
        }
        break;
      case "reactorInput":
        if (typeof m.id === "string" && m.event && typeof m.event === "object") {
          this.handlers?.onReactorInput(m.id, m.event);
        }
        break;
      case "openLocation":
        if (typeof m.fileName === "string" && typeof m.line === "number") {
          void this.handleOpenLocation(m.fileName, m.line, m.column);
        }
        break;
      case "saveSvg":
        if (typeof m.svg === "string") {
          void this.saveText("image", "svg", m.svg, m.source);
        }
        break;
      case "saveCsv":
        if (typeof m.csv === "string") {
          void this.saveText("table", "csv", m.csv, m.source);
        }
        break;
    }
  }

  private async handleOpenLocation(
    fileName: string,
    line: number,
    column: number | undefined,
  ): Promise<void> {
    const uri = this.fileMap.get(fileName);
    if (!uri) return;
    const lineIndex = Math.max(0, line - 1);
    const colIndex = Math.max(0, (column ?? 1) - 1);
    const position = new vscode.Position(lineIndex, colIndex);
    await vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(position, position),
      preserveFocus: false,
    });
  }

  /** Offer a save dialog for generated text (image SVG / table CSV). */
  private async saveText(
    what: "image" | "table",
    extension: "svg" | "csv",
    contents: string,
    source: string | undefined,
  ): Promise<void> {
    const label = extension.toUpperCase();
    const target = await vscode.window.showSaveDialog({
      filters: { [`${label} file`]: [extension] },
      saveLabel: `Save ${what}`,
      defaultUri: vscode.Uri.file(
        `${(source ?? what).replace(/[^a-zA-Z0-9_.-]+/g, "_")}.${extension}`,
      ),
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(contents));
    vscode.window.showInformationMessage(`Saved ${what} to ${target.fsPath}`);
  }

  /* -------- Internals -------- */

  /** Everything the view needs to render the current session from scratch. */
  private replayMessage(): HostMessageReplay {
    return {
      type: "replay",
      mode: "session",
      title: this.title,
      entries: this.entries,
      prompt: this.prompt,
      busy: this.busy,
      status: this.status,
      awaitingInput: this.awaitingInput,
      inputPrefix: this.inputPrefix,
    };
  }

  private dropPendingAppends(): void {
    this.pendingAppends = [];
    if (this.appendTimer !== null) {
      clearTimeout(this.appendTimer);
      this.appendTimer = null;
    }
  }

  private flushAppends(): void {
    if (this.appendTimer !== null) {
      clearTimeout(this.appendTimer);
      this.appendTimer = null;
    }
    if (this.pendingAppends.length === 0) return;
    const entries = this.pendingAppends;
    this.pendingAppends = [];
    this.send({ type: "appendMany", entries });
  }

  /** Send `msg`, after any queued appends so nothing overtakes them. */
  private post(msg: HostToView): void {
    this.flushAppends();
    this.send(msg);
  }

  private send(msg: HostToView): void {
    if (!this.view || !this.webviewReady) return;
    void this.view.webview.postMessage(msg);
  }

  dispose(): void {
    this.dropPendingAppends();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.view = null;
  }

  private renderHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "interactionsView", "style.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "interactionsView", "main.js"),
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Python Language Levels</title>
</head>
<body class="mode-empty">
  <div id="root">
    <div id="header">
      <span id="title" class="title"></span>
      <div class="actions">
        <button id="clear" title="Clear interactions (Ctrl/Cmd+L)">Clear</button>
      </div>
    </div>
    <div id="stream">
      <div id="empty"></div>
    </div>
    <div id="inputRow">
      <span id="prompt" class="prompt">&gt;&gt;&gt;</span>
      <textarea id="input" rows="1" autocomplete="off" spellcheck="false"
        autocapitalize="off" wrap="soft"></textarea>
      <span id="status" class="status"></span>
      <button id="stop" title="Stop the running program (Ctrl/Cmd+C)" hidden>Stop</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/* -------- Helpers -------- */

/**
 * Convert an AnalysisFinding into the shape the webview renders. Exposed
 * for callers (e.g. the session manager) that need to manufacture
 * FindingEntry objects directly without going through `appendFinding`.
 */
function makeNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
