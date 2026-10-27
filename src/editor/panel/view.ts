import * as vscode from "vscode";
import type { SerializedFinding } from "../../run/finding";
import type { ExamplarEntry } from "../../run/examplar";
import type {
  ExecutionImageChunk,
  ExecutionReactorChunk,
  ExecutionTableChunk,
  ExecutionTestReportChunk,
} from "../../run/types";
import type { UniverseStatus } from "../reactors/universe";
import { showInfo } from "../notify";

/**
 * The PLL interactions view replaces both the pseudoterminal REPL and the
 * standalone image view: it is a single webview that displays banners, user
 * echoes, stdout/stderr, results, images, and structured errors as a stream,
 * with an input row at the bottom for new REPL submissions.
 *
 * Sessions
 * --------
 * The view itself is unaware of sessions; the session manager owns one
 * `Session` per Python file, and the one with no file, and uses
 * `show(entries, state, file)` to swap which session's content is visible -
 * there is always one. Updates go through `append`, `clear`, `updateReactor`
 * and `setState`, which the session manager calls only for the session shown.
 *
 * Everything the view sends its webview, and each change of whether it is
 * visible, is also an `onDidChange` event, which PLL's API passes on to other
 * extensions (`../api.ts`). It fires whether or not the webview has loaded.
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
}

/**
 * A reactor's card: the reactor as it was shown, and what the host drives.
 * Unlike every other entry this one is *live*: the host keeps patching it
 * as frames arrive, and it sends controls and input back.
 */
export type ReactorEntry = ExecutionReactorChunk & {
  /** Whether its clock ticks it, while the card is drawn. */
  playing: boolean;
  connection: UniverseStatus;
  /** Why the connection is in that state, when there is something to say. */
  connectionDetail?: string;
};

/** Fields of a `ReactorEntry` the host may update in place. */
export type ReactorPatch = Partial<Omit<ReactorEntry, "kind" | "id" | "title">>;

export type PromptKind = "primary" | "continuation";

/** What the header and the input row show: everything about the panel but its entries. */
export interface PanelState {
  /** The header: the file, and its level once it has run (`hello.py [beginner]`). */
  title: string;
  prompt: PromptKind;
  /** What is being done - "Running...", "Loading libraries..." - or null when nothing is. */
  status: string | null;
  /** A running program is waiting in `input()`, so the row takes a line though it is busy. */
  awaitingInput: boolean;
  /** What the program printed before `input()` asked: shown in place of the prompt. */
  inputPrefix: string;
}

/* -------------------------------------------------------------- */
/* Host-side message types                                         */
/* -------------------------------------------------------------- */

interface HostMessageAppendMany {
  type: "appendMany";
  entries: Entry[];
}
interface HostMessageReactorPatch {
  type: "reactorPatch";
  id: string;
  patch: ReactorPatch;
}
type HostToView =
  | HostMessageAppendMany
  | HostMessageReactorPatch
  | { type: "clear" }
  /**
   * A session, from scratch: its entries and its state, and its file's URI
   * (null for the session with no file).
   */
  | { type: "show"; entries: Entry[]; state: PanelState; file: string | null }
  | { type: "state"; state: PanelState }
  | { type: "focusInput" };

/** What the panel shows changing, as `onDidChange` tells it. */
export type InteractionsChange =
  | Exclude<HostToView, { type: "focusInput" }>
  | { type: "visible"; visible: boolean };

/* -------------------------------------------------------------- */
/* View-side message types                                         */
/* -------------------------------------------------------------- */

type ViewToHost =
  | { type: "ready" }
  | { type: "submit"; code: string }
  | { type: "interrupt" }
  | { type: "clearRequested" }
  /** play / pause / step / back / reset / seek on a reactor card. */
  | { type: "reactorControl"; id: string; action: string; index?: number }
  /** A key press or mouse event over a reactor's picture. */
  | { type: "reactorInput"; id: string; event: object }
  | { type: "openLocation"; fileName: string; line: number; column: number | null }
  | { type: "saveSvg"; svg: string; source?: string }
  | { type: "saveCsv"; csv: string; source?: string };

/**
 * A message from the webview as one of `ViewToHost`, or null when it is not
 * one. The webview is PLL's own script, but what crosses `postMessage` is
 * only data, so each field is checked rather than trusted.
 */
function viewMessage(msg: unknown): ViewToHost | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const text = (value: unknown) => typeof value === "string";
  const optional = (value: unknown, kind: "string" | "number") =>
    value === undefined || typeof value === kind;
  switch (m.type) {
    case "ready":
    case "interrupt":
    case "clearRequested":
      return { type: m.type };
    case "submit":
      return text(m.code) ? { type: "submit", code: m.code as string } : null;
    case "reactorControl":
      return text(m.id) && text(m.action) && optional(m.index, "number")
        ? { type: "reactorControl", id: m.id as string, action: m.action as string, index: m.index as number | undefined }
        : null;
    case "reactorInput":
      return text(m.id) && m.event !== null && typeof m.event === "object"
        ? { type: "reactorInput", id: m.id as string, event: m.event as object }
        : null;
    case "openLocation":
      return text(m.fileName) && typeof m.line === "number"
        ? {
            type: "openLocation",
            fileName: m.fileName as string,
            line: m.line,
            column: typeof m.column === "number" ? m.column : null,
          }
        : null;
    case "saveSvg":
      return text(m.svg) && optional(m.source, "string")
        ? { type: "saveSvg", svg: m.svg as string, source: m.source as string | undefined }
        : null;
    case "saveCsv":
      return text(m.csv) && optional(m.source, "string")
        ? { type: "saveCsv", csv: m.csv as string, source: m.source as string | undefined }
        : null;
    default:
      return null;
  }
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
  /**
   * A click on a location: `fileName` as the entry shows it, a 1-based
   * line, a 0-based column (or null). Resolved by the session manager,
   * which knows whose output the entry is.
   */
  onOpenLocation(fileName: string, line: number, column: number | null): void;
  /** The webview has (re)loaded and has nothing on it: show it the visible session. */
  onViewReady(): void;
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

  // What the view shows is the session manager's, which replays it when the
  // webview (re)loads - so there is no copy here to keep in step.

  // Appends waiting to be sent as one `appendMany`.
  private pendingAppends: Entry[] = [];
  private appendTimer: ReturnType<typeof setTimeout> | null = null;

  // Optional callbacks - the session manager installs these.
  private handlers: InteractionsHandlers | null = null;

  private readonly changes = new vscode.EventEmitter<InteractionsChange>();
  readonly onDidChange = this.changes.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Whether the view is on screen. */
  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  setHandlers(handlers: InteractionsHandlers): void {
    this.handlers = handlers;
  }

  /* -------- Session swapping -------- */

  /**
   * Show a session from scratch: when the active editor changes to another
   * Python file, and when the webview (re)loads.
   */
  show(entries: ReadonlyArray<Entry>, state: PanelState, file: string | null): void {
    // This carries every entry, so anything queued is already in it.
    this.dropPendingAppends();
    this.post({ type: "show", entries: [...entries], state, file });
  }

  /** The header and the input row, as they are now. */
  setState(state: PanelState): void {
    this.post({ type: "state", state });
  }

  /* -------- Top-level operations the session manager calls -------- */
  /* These all assume the addressed session is the active one. The
   * session manager is responsible for not calling them for inactive
   * sessions. */

  append(entry: Entry): void {
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
    this.post({ type: "reactorPatch", id, patch });
  }

  clear(): void {
    // Queued appends belong to entries that no longer exist; sending them
    // after a clear would resurrect them.
    this.dropPendingAppends();
    this.post({ type: "clear" });
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
      view.onDidChangeVisibility(() => this.changes.fire({ type: "visible", visible: view.visible })),
      view.onDidDispose(() => {
        this.view = null;
        this.webviewReady = false;
        this.changes.fire({ type: "visible", visible: false });
      }),
    );
    this.changes.fire({ type: "visible", visible: view.visible });
  }

  private handleMessage(msg: unknown): void {
    const m = viewMessage(msg);
    if (m === null) return;
    switch (m.type) {
      case "ready":
        this.webviewReady = true;
        // A fresh webview has nothing on it; the session manager says what
        // it should show.
        this.handlers?.onViewReady();
        break;
      case "submit":
        this.handlers?.onSubmit(m.code);
        break;
      case "interrupt":
        this.handlers?.onInterrupt();
        break;
      case "clearRequested":
        this.handlers?.onClearRequested();
        break;
      case "reactorControl":
        this.handlers?.onReactorControl(m.id, m.action, m.index);
        break;
      case "reactorInput":
        this.handlers?.onReactorInput(m.id, m.event);
        break;
      case "openLocation":
        this.handlers?.onOpenLocation(m.fileName, m.line, m.column);
        break;
      case "saveSvg":
        void this.saveText("image", "svg", m.svg, m.source);
        break;
      case "saveCsv":
        void this.saveText("table", "csv", m.csv, m.source);
        break;
    }
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
    void showInfo(`saved the ${what} to ${target.fsPath}.`);
  }

  /* -------- Internals -------- */

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
    if (msg.type !== "focusInput") this.changes.fire(msg);
    if (!this.view || !this.webviewReady) return;
    void this.view.webview.postMessage(msg);
  }

  dispose(): void {
    this.dropPendingAppends();
    this.changes.dispose();
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
<body class="mode-waiting">
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
 * The nonce that lets the view's own script run under its CSP. It has to be
 * unguessable - anything that could predict it could run a script of its
 * own in the view - so it comes from the platform's cryptographic source,
 * which both hosts have, rather than `Math.random`.
 */
function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
