import * as vscode from "vscode";
import type { AnalysisFinding } from "./analyzers/types";

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
 * When no Python file has ever been active in the workspace, the view
 * shows a placeholder message and hides the input row. `showEmpty(...)`
 * switches into that mode; `showSession(...)` switches back.
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
export interface ImageEntry {
  kind: "image";
  svg: string;
  width: number;
  height: number;
  source?: string;
}
export interface TableEntry {
  kind: "table";
  columns: string[];
  rows: string[][];
  rowCount: number;
  shownCount: number;
  truncated: boolean;
  source?: string;
}
export interface FindingEntry {
  kind: "finding";
  finding: SerializedFinding;
}
export interface SerializedFinding {
  errorType: string;
  headline: string;
  howToFix: string[];
  location: { fileName: string; line: number; column: number | null; label: string } | null;
}
export interface RawErrorEntry {
  kind: "rawError";
  errorType: string;
  message: string;
  traceback: string;
}

export interface TestCaseView {
  name: string;
  outcome: string;
  lineNumber: number | null;
  message: string | null;
  stdout: string | null;
}

export interface TestReportEntry {
  kind: "testReport";
  fileName: string;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  tests: TestCaseView[];
}

export type PromptKind = "primary" | "continuation";

/* -------------------------------------------------------------- */
/* Host-side message types                                         */
/* -------------------------------------------------------------- */

interface HostMessageAppend {
  type: "append";
  entry: Entry;
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
interface HostMessageClipboard {
  type: "clipboard";
  op: "copyOrInterrupt" | "cut" | "paste";
  text?: string;
}
type HostToView =
  | HostMessageAppend
  | HostMessageClear
  | HostMessagePrompt
  | HostMessageBusy
  | HostMessageAwaitingInput
  | HostMessageReplay
  | HostMessageEmpty
  | HostMessageTitle
  | HostMessageFocus
  | HostMessageClipboard;

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
}

const VIEW_ID = "pllInteractionsView";

export class InteractionsView
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = VIEW_ID;

  private view: vscode.WebviewView | null = null;
  private webviewReady = false;
  private readonly disposables: vscode.Disposable[] = [];
  private clipboardWaiters: Array<(result: { text: string; hadSelection: boolean }) => void> =
    [];

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
    this.title = state.title;
    this.entries = [...state.entries];
    this.prompt = state.prompt;
    this.busy = state.busy;
    this.status = state.status;
    this.awaitingInput = state.awaitingInput ?? false;
    this.inputPrefix = state.inputPrefix ?? "";
    this.post({
      type: "replay",
      mode: "session",
      title: this.title,
      entries: this.entries,
      prompt: this.prompt,
      busy: this.busy,
      status: this.status,
      awaitingInput: this.awaitingInput,
      inputPrefix: this.inputPrefix,
    });
  }

  /** Switch the view into the empty placeholder state. */
  showEmpty(message: string): void {
    this.mode = "empty";
    this.emptyMessage = message;
    this.title = "";
    this.entries = [];
    this.post({ type: "empty", message });
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
    this.post({ type: "append", entry });
  }

  appendBanner(text: string): void {
    this.append({ kind: "banner", text });
  }

  appendEcho(prompt: ">>>" | "...", code: string): void {
    this.append({ kind: "echo", prompt, code });
  }

  appendStdout(text: string): void {
    this.append({ kind: "stdout", text });
  }

  appendStderr(text: string): void {
    this.append({ kind: "stderr", text });
  }

  appendResult(repr: string): void {
    this.append({ kind: "result", repr });
  }

  appendImage(image: { svg: string; width: number; height: number; source?: string }): void {
    this.append({ kind: "image", ...image });
  }

  appendTable(table: {
    columns: string[];
    rows: string[][];
    rowCount: number;
    shownCount: number;
    truncated: boolean;
    source?: string;
  }): void {
    this.append({ kind: "table", ...table });
  }

  appendFinding(finding: AnalysisFinding): void {
    this.append({ kind: "finding", finding: serializeFinding(finding) });
  }

  appendRawError(errorType: string, message: string, traceback: string): void {
    this.append({ kind: "rawError", errorType, message, traceback });
  }

  clear(): void {
    if (this.mode !== "session") return;
    this.entries = [];
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

  /**
   * vscode.dev steals Ctrl/Cmd+C/V before the webview iframe sees them.
   * These go through `vscode.env.clipboard` and a message to the view.
   */
  async copySelectionOrInterrupt(): Promise<void> {
    const result = await this.requestClipboard("copyOrInterrupt");
    if (result.hadSelection) {
      await vscode.env.clipboard.writeText(result.text);
    }
  }

  async cutSelection(): Promise<void> {
    const result = await this.requestClipboard("cut");
    if (result.hadSelection) {
      await vscode.env.clipboard.writeText(result.text);
    }
  }

  async pasteClipboard(): Promise<void> {
    const text = await vscode.env.clipboard.readText();
    this.post({ type: "clipboard", op: "paste", text });
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
      focused?: boolean;
      text?: string;
      hadSelection?: boolean;
    };
    switch (m.type) {
      case "ready":
        this.webviewReady = true;
        if (this.mode === "session") {
          this.post({
            type: "replay",
            mode: "session",
            title: this.title,
            entries: this.entries,
            prompt: this.prompt,
            busy: this.busy,
            status: this.status,
            awaitingInput: this.awaitingInput,
            inputPrefix: this.inputPrefix,
          });
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
      case "openLocation":
        if (typeof m.fileName === "string" && typeof m.line === "number") {
          void this.handleOpenLocation(m.fileName, m.line, m.column);
        }
        break;
      case "saveSvg":
        if (typeof m.svg === "string") {
          void this.handleSaveSvg(m.svg, m.source);
        }
        break;
      case "saveCsv":
        if (typeof m.csv === "string") {
          void this.handleSaveCsv(m.csv, m.source);
        }
        break;
      case "viewFocus":
        void vscode.commands.executeCommand(
          "setContext",
          "pllInteractionsFocus",
          !!m.focused,
        );
        break;
      case "clipboardResult": {
        const waiter = this.clipboardWaiters.shift();
        waiter?.({
          text: typeof m.text === "string" ? m.text : "",
          hadSelection: !!m.hadSelection,
        });
        break;
      }
    }
  }

  private requestClipboard(
    op: "copyOrInterrupt" | "cut",
  ): Promise<{ text: string; hadSelection: boolean }> {
    return new Promise((resolve) => {
      this.clipboardWaiters.push(resolve);
      this.post({ type: "clipboard", op });
      setTimeout(() => {
        const idx = this.clipboardWaiters.indexOf(resolve);
        if (idx >= 0) {
          this.clipboardWaiters.splice(idx, 1);
          resolve({ text: "", hadSelection: false });
        }
      }, 1000);
    });
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

  private async handleSaveSvg(svg: string, source: string | undefined): Promise<void> {
    const defaultName = (source ?? "image").replace(/[^a-zA-Z0-9_.-]+/g, "_") + ".svg";
    const target = await vscode.window.showSaveDialog({
      filters: { "SVG image": ["svg"] },
      saveLabel: "Save image",
      defaultUri: vscode.Uri.file(defaultName),
    });
    if (!target) return;
    const data = new TextEncoder().encode(svg);
    await vscode.workspace.fs.writeFile(target, data);
    vscode.window.showInformationMessage(`Saved image to ${target.fsPath}`);
  }

  private async handleSaveCsv(csv: string, source: string | undefined): Promise<void> {
    const defaultName = (source ?? "table").replace(/[^a-zA-Z0-9_.-]+/g, "_") + ".csv";
    const target = await vscode.window.showSaveDialog({
      filters: { "CSV file": ["csv"] },
      saveLabel: "Save table",
      defaultUri: vscode.Uri.file(defaultName),
    });
    if (!target) return;
    const data = new TextEncoder().encode(csv);
    await vscode.workspace.fs.writeFile(target, data);
    vscode.window.showInformationMessage(`Saved table to ${target.fsPath}`);
  }

  /* -------- Internals -------- */

  private post(msg: HostToView): void {
    if (!this.view || !this.webviewReady) return;
    void this.view.webview.postMessage(msg);
  }

  dispose(): void {
    void vscode.commands.executeCommand("setContext", "pllInteractionsFocus", false);
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
export function serializeFinding(finding: AnalysisFinding): SerializedFinding {
  let location: SerializedFinding["location"] = null;
  if (
    finding.lineNumber !== null &&
    finding.fileName !== "<repl>" &&
    finding.fileName !== "<input>"
  ) {
    const label =
      finding.column !== null
        ? `${finding.fileName}:${finding.lineNumber}:${finding.column + 1}`
        : `${finding.fileName}:${finding.lineNumber}`;
    location = {
      fileName: finding.fileName,
      line: finding.lineNumber,
      column: finding.column,
      label,
    };
  }
  return {
    errorType: finding.errorType,
    headline: finding.headline,
    howToFix: [...finding.howToFix],
    location,
  };
}

function makeNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
