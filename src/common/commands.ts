import * as vscode from "vscode";
import { findRuntimeFinding } from "./analyzers/registry";
import { BonnieDiagnostics } from "./diagnostics";
import { parsePythonError } from "./errors/pythonErrorParser";
import { BonnieOutput } from "./output";
import type {
  ExecutionErrorChunk,
  ExecutionEvent,
  ExecutionEventHandler,
  PythonRuntime,
} from "./types";

export interface BonnieServices {
  runtime: PythonRuntime;
  output: BonnieOutput;
  diagnostics: BonnieDiagnostics;
}

interface ReplState {
  buffer: string[];
  history: string[];
}

const REPL_STATES = new WeakMap<BonnieOutput, ReplState>();

export function registerCommands(
  context: vscode.ExtensionContext,
  services: BonnieServices,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("bonniePython.startRepl", () =>
      startRepl(services).catch((err) => reportError(services.output, err)),
    ),
    vscode.commands.registerCommand("bonniePython.runActiveFile", () =>
      runActiveFile(services).catch((err) => reportError(services.output, err)),
    ),
  );
}

async function startRepl(services: BonnieServices): Promise<void> {
  const { output, runtime } = services;
  output.show();
  output.writeBanner("Python REPL (Pyodide)");
  output.writeLine("  Type Python expressions or statements; cancel the prompt to exit.");
  output.writeLine("  An empty line on a continued block runs the buffered code.");
  output.writeLine();

  if (!runtime.isReady()) {
    output.writeLine("  Loading Pyodide... (first run can take a few seconds)");
    await runtime.initialize();
    output.writeLine("  Ready.");
    output.writeLine();
  }

  const state: ReplState = REPL_STATES.get(output) ?? { buffer: [], history: [] };
  REPL_STATES.set(output, state);

  while (true) {
    const continuing = state.buffer.length > 0;
    const promptText = continuing ? "..." : ">>>";
    const input = await vscode.window.showInputBox({
      prompt: `${promptText} Python`,
      placeHolder: continuing ? "(continued line - empty submits)" : "e.g. 1 + 1",
      ignoreFocusOut: true,
    });
    if (input === undefined) {
      if (state.buffer.length > 0) {
        output.writeLine("  REPL input cancelled - clearing buffer.");
        state.buffer = [];
      } else {
        output.writeLine("  REPL closed.");
      }
      return;
    }

    if (continuing && input.trim() === "") {
      const code = state.buffer.join("\n");
      state.buffer = [];
      state.history.push(code);
      output.writePrompt(formatBuffered(code));
      await runReplCode(services, code);
      continue;
    }

    if (looksLikeBlockStart(input) || continuing) {
      state.buffer.push(input);
      continue;
    }

    state.history.push(input);
    output.writePrompt(input);
    await runReplCode(services, input);
  }
}

async function runReplCode(services: BonnieServices, code: string): Promise<void> {
  const { runtime, output } = services;
  const handler: ExecutionEventHandler = (event: ExecutionEvent) => {
    if (event.kind === "error") {
      handleErrorEvent(services, event, code, "<repl>", undefined);
      return;
    }
    output.writeExecutionEvent(event);
  };
  await runtime.replEval({ code }, handler);
}

async function runActiveFile(services: BonnieServices): Promise<void> {
  const { output, runtime, diagnostics } = services;
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Bonnie Python: no active editor.");
    return;
  }
  const document = editor.document;
  if (document.languageId !== "python") {
    vscode.window.showWarningMessage("Bonnie Python: active file is not Python.");
    return;
  }

  diagnostics.clear(document.uri);

  const fileName = document.uri.path.split("/").pop() ?? "user_script.py";
  output.show();
  output.writeBanner(`Run ${fileName}`);

  if (!runtime.isReady()) {
    output.writeLine("  Loading Pyodide... (first run can take a few seconds)");
    await runtime.initialize();
    output.writeLine("  Ready.");
    output.writeLine();
  }

  let sawError = false;
  const handler: ExecutionEventHandler = (event: ExecutionEvent) => {
    if (event.kind === "error") {
      sawError = true;
      handleErrorEvent(services, event, document.getText(), fileName, document);
      return;
    }
    output.writeExecutionEvent(event);
  };

  await runtime.runFile({ code: document.getText(), fileName }, handler);

  if (!sawError) {
    output.writeLine();
    output.writeLine(`  Finished ${fileName} (no errors).`);
  }
}

function handleErrorEvent(
  services: BonnieServices,
  event: ExecutionErrorChunk,
  source: string,
  fileName: string,
  document: vscode.TextDocument | undefined,
): void {
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
    services.output.writeFriendlyError(finding);
    if (document) {
      services.diagnostics.setFinding(document.uri, document, finding);
    }
  } else {
    services.output.writeRawError(traceback);
  }
}

function looksLikeBlockStart(line: string): boolean {
  return /:\s*(#.*)?$/.test(line) || /\\\s*$/.test(line);
}

function formatBuffered(code: string): string {
  const [first, ...rest] = code.split("\n");
  if (rest.length === 0) {
    return first;
  }
  return [first, ...rest.map((l) => `    ${l}`)].join("\n");
}

function reportError(output: BonnieOutput, err: unknown): void {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  output.writeLine();
  output.writeLine("Bonnie Python error:");
  output.writeLine(message);
  vscode.window.showErrorMessage(`Bonnie Python: ${err instanceof Error ? err.message : String(err)}`);
}
