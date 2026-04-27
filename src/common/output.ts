import * as vscode from "vscode";
import type { AnalysisFinding } from "./analyzers/types";
import type { ExecutionEvent } from "./types";

const SEPARATOR = "─".repeat(60);

export class BonnieOutput {
  private readonly channel: vscode.OutputChannel;

  constructor(name = "Python (Bonnie)") {
    this.channel = vscode.window.createOutputChannel(name);
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  writeLine(line = ""): void {
    this.channel.appendLine(line);
  }

  write(text: string): void {
    this.channel.append(text);
  }

  writeBanner(title: string): void {
    this.writeLine();
    this.writeLine(SEPARATOR);
    this.writeLine(`  ${title}`);
    this.writeLine(SEPARATOR);
  }

  writePrompt(text: string): void {
    this.writeLine(`>>> ${text}`);
  }

  writeReplResult(repr: string | null): void {
    if (repr !== null && repr !== undefined) {
      this.writeLine(repr);
    }
  }

  writeRawError(traceback: string): void {
    this.writeLine();
    this.writeLine("Traceback (raw):");
    for (const line of traceback.split(/\r?\n/)) {
      this.writeLine(`  ${line}`);
    }
  }

  writeFriendlyError(finding: AnalysisFinding): void {
    this.writeLine();
    this.writeLine(SEPARATOR);
    this.writeLine(`  ${finding.errorType}: ${finding.headline}`);
    this.writeLine(SEPARATOR);

    if (finding.lineNumber !== null) {
      const where = finding.column !== null
        ? `line ${finding.lineNumber}, column ${finding.column + 1}`
        : `line ${finding.lineNumber}`;
      this.writeLine(`  At ${where}` + (finding.nameToken ? ` (\`${finding.nameToken}\`)` : ""));
    }

    this.writeSection("What happened", finding.whatHappened);
    this.writeSection("Why this might happen", finding.whyItHappens);
    this.writeSection("How to fix", finding.howToFix);

    this.writeLine();
    this.writeLine("(Original Python message below)");
    for (const line of finding.raw.split(/\r?\n/)) {
      this.writeLine(`  ${line}`);
    }
  }

  writeExecutionEvent(event: ExecutionEvent): void {
    switch (event.kind) {
      case "stdout":
        this.write(event.text);
        break;
      case "stderr":
        this.write(event.text);
        break;
      case "result":
        if (event.repr !== null && event.repr !== undefined) {
          this.writeLine(event.repr);
        }
        break;
      case "error":
        this.writeLine();
        this.writeLine(`${event.errorType}: ${event.message}`);
        break;
      case "done":
        break;
    }
  }

  dispose(): void {
    this.channel.dispose();
  }

  private writeSection(title: string, lines: string[]): void {
    if (lines.length === 0) {
      return;
    }
    this.writeLine();
    this.writeLine(`  ${title}:`);
    for (const line of lines) {
      const wrapped = wrapText(line, 76);
      const [first, ...rest] = wrapped;
      this.writeLine(`    - ${first}`);
      for (const cont of rest) {
        this.writeLine(`      ${cont}`);
      }
    }
  }
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current += " " + word;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}
