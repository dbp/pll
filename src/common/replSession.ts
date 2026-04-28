import * as vscode from "vscode";
import { findRuntimeFinding } from "./analyzers/registry";
import { ANSI, color, CRLF, toCRLF } from "./ansi";
import type { BonnieDiagnostics } from "./diagnostics";
import { parsePythonError } from "./errors/pythonErrorParser";
import { formatFriendlyErrorAnsi } from "./errorFormatter";
import type { ExecutionEvent, PythonRuntime } from "./types";

const PROMPT = color(">>>", ANSI.green) + " ";
const CONT_PROMPT = color("...", ANSI.green) + " ";
const TERMINAL_NAME = "Python (Bonnie REPL)";

export interface BonnieReplDeps {
  runtime: PythonRuntime;
  diagnostics: BonnieDiagnostics;
}

interface PendingRunFile {
  code: string;
  fileName: string;
  documentUri?: vscode.Uri;
}

/**
 * A real REPL on top of vscode.Pseudoterminal.
 *
 * - Same `_bonnie_user_globals` is used for all evaluations and for `runFile`,
 *   so definitions made by running a file persist into REPL evaluations.
 * - Multi-line input is detected by asking Pyodide via codeop.compile_command;
 *   incomplete input switches to a `...` prompt. An empty line in continuation
 *   force-executes the buffered block (matches CPython's interactive shell).
 * - Up/Down arrows scroll through history.
 * - Errors are rendered with ANSI colors via formatFriendlyErrorAnsi and also
 *   raised as VS Code diagnostics on the originating document.
 */
export class BonnieReplSession {
  private terminal: vscode.Terminal | null = null;
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();

  private inputBuffer = "";
  private continuationLines: string[] = [];
  private continuing = false;

  private history: string[] = [];
  private historyIdx = -1;
  private historyDraft = "";

  private opened = false;
  private initialized = false;
  private execChain: Promise<void> = Promise.resolve();
  private busy = false;

  private pendingRunFile: PendingRunFile | null = null;

  constructor(private readonly deps: BonnieReplDeps) {}

  /** Show (and create if needed) the REPL terminal. */
  show(preserveFocus = false): void {
    this.ensureTerminal();
    this.terminal!.show(preserveFocus);
  }

  /** Run a file inside this REPL so its globals persist for the next prompt. */
  runFile(code: string, fileName: string, document?: vscode.TextDocument): Promise<void> {
    this.show();
    if (!this.opened || !this.initialized) {
      this.pendingRunFile = { code, fileName, documentUri: document?.uri };
      return Promise.resolve();
    }
    return this.enqueue(() => this.executeFile(code, fileName, document));
  }

  dispose(): void {
    this.terminal?.dispose();
    this.terminal = null;
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private ensureTerminal(): void {
    if (this.terminal) {
      return;
    }
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writeEmitter.event,
      onDidClose: this.closeEmitter.event,
      open: () => {
        void this.handleOpen();
      },
      close: () => this.handleClose(),
      handleInput: (data) => this.handleInput(data),
    };
    this.terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      pty,
      isTransient: true,
    });
  }

  private write(text: string): void {
    this.writeEmitter.fire(text);
  }

  private writeLine(text = ""): void {
    this.write(text + CRLF);
  }

  private async handleOpen(): Promise<void> {
    this.opened = true;
    this.writeLine(color("Bonnie Python REPL", ANSI.bold, ANSI.cyan));
    this.writeLine(color("Loading Pyodide...", ANSI.dim));
    try {
      await this.deps.runtime.initialize();
    } catch (err) {
      this.writeLine(
        color("Failed to initialize Pyodide: ", ANSI.red, ANSI.bold) +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    this.initialized = true;
    this.writeLine(color("Ready.", ANSI.green));
    this.writeLine(
      color("  Definitions from `Run Active File` are available here.", ANSI.dim),
    );
    this.writeLine(color("  Up/Down arrows scroll history. Ctrl+C clears input.", ANSI.dim));

    if (this.pendingRunFile) {
      const pending = this.pendingRunFile;
      this.pendingRunFile = null;
      const document = pending.documentUri ? this.findDocument(pending.documentUri) : undefined;
      await this.enqueue(() => this.executeFile(pending.code, pending.fileName, document));
      return;
    }
    this.prompt();
  }

  private findDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  }

  private handleClose(): void {
    this.terminal = null;
    this.opened = false;
    this.initialized = false;
    this.inputBuffer = "";
    this.continuationLines = [];
    this.continuing = false;
    this.historyIdx = -1;
    this.historyDraft = "";
  }

  private prompt(): void {
    this.write(this.continuing ? CONT_PROMPT : PROMPT);
  }

  private redrawCurrentLine(): void {
    this.write("\x1b[2K\r");
    this.prompt();
    this.write(this.inputBuffer);
  }

  private handleInput(data: string): void {
    if (this.busy) {
      return;
    }
    let i = 0;
    while (i < data.length) {
      const ch = data.charCodeAt(i);

      if (ch === 0x1b && data[i + 1] === "[") {
        const seq = data.substring(i, i + 3);
        if (seq === "\x1b[A") {
          this.historyUp();
          i += 3;
          continue;
        }
        if (seq === "\x1b[B") {
          this.historyDown();
          i += 3;
          continue;
        }
        i += 3;
        continue;
      }

      if (ch === 0x03) {
        this.write(color("^C", ANSI.dim) + CRLF);
        this.inputBuffer = "";
        this.continuationLines = [];
        this.continuing = false;
        this.prompt();
        i += 1;
        continue;
      }

      if (ch === 0x7f || ch === 0x08) {
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.write("\b \b");
        }
        i += 1;
        continue;
      }

      if (ch === 0x0d) {
        this.write(CRLF);
        const line = this.inputBuffer;
        this.inputBuffer = "";
        void this.processLine(line);
        i += 1;
        continue;
      }

      if (ch >= 0x20) {
        const c = data[i];
        this.inputBuffer += c;
        this.write(c);
      }
      i += 1;
    }
  }

  private historyUp(): void {
    if (this.history.length === 0) {
      return;
    }
    if (this.historyIdx === -1) {
      this.historyDraft = this.inputBuffer;
      this.historyIdx = this.history.length - 1;
    } else if (this.historyIdx > 0) {
      this.historyIdx -= 1;
    }
    this.inputBuffer = this.history[this.historyIdx];
    this.redrawCurrentLine();
  }

  private historyDown(): void {
    if (this.historyIdx === -1) {
      return;
    }
    this.historyIdx += 1;
    if (this.historyIdx >= this.history.length) {
      this.historyIdx = -1;
      this.inputBuffer = this.historyDraft;
      this.historyDraft = "";
    } else {
      this.inputBuffer = this.history[this.historyIdx];
    }
    this.redrawCurrentLine();
  }

  private async processLine(rawLine: string): Promise<void> {
    if (this.continuing) {
      if (rawLine.trim() === "") {
        const code = this.continuationLines.join("\n");
        this.continuationLines = [];
        this.continuing = false;
        if (code.trim() === "") {
          this.prompt();
          return;
        }
        await this.enqueue(() => this.executeRepl(code));
        return;
      }
      this.continuationLines.push(rawLine);
      const buffered = this.continuationLines.join("\n");
      const status = await this.deps.runtime.checkReplComplete(buffered);
      if (status.status === "complete") {
        this.continuationLines = [];
        this.continuing = false;
        await this.enqueue(() => this.executeRepl(buffered));
      } else {
        this.prompt();
      }
      return;
    }

    if (rawLine.trim() === "") {
      this.prompt();
      return;
    }

    const status = await this.deps.runtime.checkReplComplete(rawLine);
    if (status.status === "incomplete") {
      this.continuationLines.push(rawLine);
      this.continuing = true;
      this.prompt();
      return;
    }

    await this.enqueue(() => this.executeRepl(rawLine));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.execChain.then(task);
    this.execChain = next.catch(() => undefined);
    return next;
  }

  private async executeRepl(code: string): Promise<void> {
    this.busy = true;
    this.history.push(code);
    this.historyIdx = -1;
    this.historyDraft = "";
    try {
      await this.deps.runtime.replEval({ code }, (event) =>
        this.handleEvent(event, code, "<repl>", undefined),
      );
    } catch (err) {
      this.writeLine(
        color("Internal error: ", ANSI.red, ANSI.bold) +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      this.busy = false;
      this.prompt();
    }
  }

  private async executeFile(
    code: string,
    fileName: string,
    document?: vscode.TextDocument,
  ): Promise<void> {
    this.busy = true;
    if (document) {
      this.deps.diagnostics.clear(document.uri);
    }
    this.writeLine(color(`# Running ${fileName}`, ANSI.dim));
    try {
      await this.deps.runtime.runFile({ code, fileName }, (event) =>
        this.handleEvent(event, code, fileName, document),
      );
      this.writeLine(color(`# Finished ${fileName}`, ANSI.dim));
    } catch (err) {
      this.writeLine(
        color("Internal error: ", ANSI.red, ANSI.bold) +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      this.busy = false;
      this.prompt();
    }
  }

  private handleEvent(
    event: ExecutionEvent,
    source: string,
    fileName: string,
    document: vscode.TextDocument | undefined,
  ): void {
    switch (event.kind) {
      case "stdout":
      case "stderr": {
        const tinted = event.kind === "stderr" ? color(event.text, ANSI.red) : event.text;
        this.write(toCRLF(tinted));
        break;
      }
      case "result":
        if (event.repr !== null && event.repr !== undefined) {
          this.writeLine(event.repr);
        }
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
        const finding = findRuntimeFinding(source, fileName, parsed);
        if (finding) {
          for (const line of formatFriendlyErrorAnsi(finding)) {
            this.writeLine(line);
          }
          if (document) {
            this.deps.diagnostics.setFinding(document.uri, document, finding);
          }
        } else {
          this.writeLine(
            color(`${event.errorType}: `, ANSI.red, ANSI.bold) + event.message,
          );
          this.write(toCRLF(traceback));
          this.writeLine();
        }
        break;
      }
      case "done":
        break;
    }
  }
}
