import * as vscode from "vscode";

/**
 * Match `<filename>.py:<line>` and `<filename>.py:<line>:<col>` inside our
 * REPL pseudoterminal output and turn them into clickable links that open
 * the document at the given location.
 *
 * VS Code already has a built-in "OS path" link detector for absolute paths,
 * but our terminal output uses bare display names (e.g. `hello.py:2:5`)
 * because that's what's stored in the Python traceback. Those don't get
 * recognized automatically, so we register our own provider that knows how
 * to look the display name back up to a real document URI.
 */
export interface BonnieTerminalLinkData {
  uri: vscode.Uri;
  line: number;
  column: number;
}

interface BonnieLink extends vscode.TerminalLink {
  data: BonnieTerminalLinkData;
}

const TERMINAL_NAME = "Python (Bonnie REPL)";
const PATTERN = /\b([\w./\\-]+\.py):(\d+)(?::(\d+))?\b/g;

export class BonnieTerminalLinkProvider
  implements vscode.TerminalLinkProvider<BonnieLink>, vscode.Disposable
{
  private readonly registration: vscode.Disposable;
  private readonly fileMap = new Map<string, vscode.Uri>();

  constructor() {
    this.registration = vscode.window.registerTerminalLinkProvider(this);
  }

  /** Tell the provider that `displayName` corresponds to `uri`. */
  registerFile(displayName: string, uri: vscode.Uri): void {
    this.fileMap.set(displayName, uri);
  }

  provideTerminalLinks(
    context: vscode.TerminalLinkContext,
  ): BonnieLink[] {
    if (context.terminal.name !== TERMINAL_NAME) {
      return [];
    }
    const links: BonnieLink[] = [];
    for (const match of context.line.matchAll(PATTERN)) {
      const displayName = match[1];
      const line = parseInt(match[2], 10);
      const column = match[3] ? parseInt(match[3], 10) : 1;
      const uri = this.fileMap.get(displayName);
      if (!uri) {
        continue;
      }
      const startIndex = match.index ?? 0;
      links.push({
        startIndex,
        length: match[0].length,
        tooltip: `Open ${displayName} at line ${line}`,
        data: { uri, line, column },
      });
    }
    return links;
  }

  async handleTerminalLink(link: BonnieLink): Promise<void> {
    const { uri, line, column } = link.data;
    const lineIndex = Math.max(0, line - 1);
    const colIndex = Math.max(0, column - 1);
    const position = new vscode.Position(lineIndex, colIndex);
    await vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(position, position),
      preserveFocus: false,
    });
  }

  dispose(): void {
    this.registration.dispose();
    this.fileMap.clear();
  }
}
