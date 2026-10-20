import * as vscode from "vscode";
import { LEVEL_NAMES, headerLevel, type Level } from "../core/level";
import {
  changeBetween,
  findLevelLine,
  lineChangeBetween,
  repairLevelLine,
  withLevel,
  type LevelLineRepair,
  type TextChange,
} from "../core/levelLine";
import { showInfo, showWarning } from "./notify";
import { isProgramDocument } from "./programDocuments";

/**
 * The `#level` line, kept in place in the editor. VS Code gives an extension
 * no way to make part of a file read-only, so the line is kept by putting
 * it back: any edit that changes it, removes it or puts something above it
 * is followed at once by one that restores it, in the same undo step where
 * VS Code allows (ARCHITECTURE.md, "The `#level` line in the editor"). A
 * selection that takes in the line and more starts on the line below it
 * instead, so that Select All and then Delete, Cut, Paste or typing leaves
 * the line alone without needing it put back - and shows that it is held.
 *
 * The line is changed or taken out on purpose with the picker: the CodeLens
 * above it, the status-bar item, or **PLL: Change Level**.
 */

/** Each level, as the picker says it. */
const LEVEL_SUMMARY: Record<Level, string> = {
  raw: "Plain Python: nothing is checked.",
  beginner: "The strictest: no reassigning, no hiding names, and annotations are checked.",
  intermediate: "As beginner, but a function may change its own variables.",
  advanced: "Python's own rules: annotations and names with no value are still checked.",
};

/** How often a put-back that lost a race with the next key is tried again. */
const RETRIES = 3;

/**
 * How long to wait for VS Code to say whether an edit left the file dirty,
 * when it says nothing: a saved file's first edit is followed by word that
 * it is dirty, and reverting by word that it is not, while further typing
 * in an unsaved file and the file read again from disk change nothing.
 */
const DIRTY_WAIT_MS = 50;

interface Kept {
  /** The text as it last was with its `#level` line in place; null for a file with none. */
  good: string | null;
  /** The text as of the last edit seen. */
  last: string;
  /**
   * The edits not yet looked at, each with the text it was made to, until
   * VS Code says whether they leave the file dirty - which tells the
   * student's edits from the file being read again from disk or reverted.
   */
  queue: { before: string; changes: TextChange[] }[];
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The text an edit of PLL's own is making, until it is seen: a put-back, or the picker's. */
  expected: { text: string; repair: boolean } | null;
  /** The selections from before the edit being put right. */
  selections: readonly vscode.Selection[] | null;
  /** The line and level the CodeLens last showed, as `line:level`, or "". */
  shown: string;
}

type PickItem = vscode.QuickPickItem & { level?: Level; remove?: true };

export class LevelLineKeeper implements vscode.Disposable {
  private readonly kept = new Map<string, Kept>();
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("pll.levelLineBackground"),
  });
  private readonly status = vscode.window.createStatusBarItem("pll.level", vscode.StatusBarAlignment.Right, 100);
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.status.name = "PLL Level";
    this.status.command = "pll.changeLevel";
    this.subscriptions = [
      this.highlight,
      this.status,
      this.lensesChanged,
      vscode.languages.registerCodeLensProvider(
        { language: "python" },
        { onDidChangeCodeLenses: this.lensesChanged.event, provideCodeLenses: (document) => this.lenses(document) },
      ),
      vscode.workspace.onDidOpenTextDocument((document) => void this.track(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.forget(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.changed(event)),
      vscode.window.onDidChangeTextEditorSelection((event) => this.selected(event)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((editor) => this.decorate(editor))),
      vscode.window.onDidChangeActiveTextEditor(() => this.showStatus()),
    ];
    for (const document of vscode.workspace.textDocuments) {
      this.track(document);
    }
    vscode.window.visibleTextEditors.forEach((editor) => this.decorate(editor));
    this.showStatus();
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.kept.forEach((kept) => clearTimeout(kept.timer));
    this.kept.clear();
  }

  /** **PLL: Change Level**: the picker, for `uri` or the active editor's file. */
  async pick(uri?: vscode.Uri): Promise<void> {
    const editor = editorFor(uri);
    if (editor === undefined || !this.applies(editor.document)) {
      void showWarning("open a Python file to choose the level it runs at.");
      return;
    }
    const line = levelLineOf(editor.document);
    const items: PickItem[] = LEVEL_NAMES.map((level) => ({
      label: level,
      description: level === line?.level ? "current" : undefined,
      detail: LEVEL_SUMMARY[level],
      level,
    }));
    if (line !== null) {
      items.push(
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        {
          label: "$(trash) Remove the #level line",
          detail: "The file then runs as plain Python, as one with no #level line does.",
          remove: true,
        },
      );
    }
    const chosen = await choose(items, line);
    if (chosen === undefined) {
      return;
    }
    if (chosen.remove) {
      await this.write(editor, null);
    } else if (chosen.level !== undefined && chosen.level !== line?.level) {
      await this.write(editor, chosen.level);
    }
  }

  /** **PLL: Remove Level Line**. */
  async remove(uri?: vscode.Uri): Promise<void> {
    const editor = editorFor(uri);
    if (editor === undefined || !this.applies(editor.document) || levelLineOf(editor.document) === null) {
      void showInfo("this file has no #level line to remove.");
      return;
    }
    await this.write(editor, null);
  }

  private forget(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.kept.get(key)?.timer);
    this.kept.delete(key);
  }

  private applies(document: vscode.TextDocument): boolean {
    return document.languageId === "python" && isProgramDocument(document.uri);
  }

  private track(document: vscode.TextDocument): Kept | null {
    if (!this.applies(document)) {
      return null;
    }
    const key = document.uri.toString();
    let kept = this.kept.get(key);
    if (kept === undefined) {
      const text = document.getText();
      kept = {
        good: findLevelLine(text) !== null ? text : null,
        last: text,
        queue: [],
        timer: undefined,
        expected: null,
        selections: null,
        shown: "",
      };
      this.kept.set(key, kept);
    }
    return kept;
  }

  private changed(event: vscode.TextDocumentChangeEvent): void {
    const { document } = event;
    const kept = this.track(document);
    if (kept === null) {
      return;
    }
    if (event.contentChanges.length === 0) {
      // Word of the dirty state, which the edits waiting were waiting for.
      if (kept.queue.length > 0) {
        this.resolve(document, kept);
      }
      return;
    }
    const text = document.getText();
    const before = kept.last;
    kept.last = text;
    const expected = kept.expected;
    kept.expected = null;
    if (expected !== null && text === expected.text) {
      this.settle(document, kept, text);
      return;
    }
    // Neither an undo or a redo, nor an edit with no editor to have made
    // it, nor one racing the picker's, is put right.
    if (event.reason !== undefined || editorFor(document.uri) === undefined || expected?.repair === false || kept.good === null) {
      this.settle(document, kept, text);
      return;
    }
    kept.queue.push({
      before,
      changes: event.contentChanges.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })),
    });
    if (document.isUntitled) {
      this.resolve(document, kept);
      return;
    }
    clearTimeout(kept.timer);
    kept.timer = setTimeout(() => this.resolve(document, kept), DIRTY_WAIT_MS);
  }

  /**
   * The edits waiting, now that VS Code has said whether they leave the
   * file dirty: the student's, which are put right, or the file read again
   * from disk or reverted, which are not.
   */
  private resolve(document: vscode.TextDocument, kept: Kept): void {
    clearTimeout(kept.timer);
    kept.timer = undefined;
    const queue = kept.queue;
    kept.queue = [];
    const text = document.getText();
    const editor = editorFor(document.uri);
    if (queue.length === 0 || kept.good === null || editor === undefined || !(document.isDirty || document.isUntitled)) {
      this.settle(document, kept, text);
      return;
    }
    // One edit of the last good text is read as VS Code reported it; more,
    // or one over a put-back still on its way, as one edit of that text.
    const changes = queue.length === 1 && queue[0].before === kept.good ? queue[0].changes : [changeBetween(kept.good, text)];
    const repair = repairLevelLine(kept.good, changes);
    if (repair === null) {
      this.settle(document, kept, text);
      return;
    }
    void this.putBack(editor, kept, text, repair, RETRIES);
  }

  /** The text is as it should be: what the next edit is read against. */
  private settle(document: vscode.TextDocument, kept: Kept, text: string): void {
    clearTimeout(kept.timer);
    kept.timer = undefined;
    kept.queue = [];
    kept.good = findLevelLine(text) !== null ? text : null;
    this.refresh(document, kept);
  }

  private async putBack(
    editor: vscode.TextEditor,
    kept: Kept,
    text: string,
    repair: LevelLineRepair,
    retries: number,
  ): Promise<void> {
    const document = editor.document;
    const selections = kept.selections ?? editor.selections;
    kept.expected = { text: repair.text, repair: true };
    const change = lineChangeBetween(text, repair.text);
    const range = new vscode.Range(document.positionAt(change.offset), document.positionAt(change.offset + change.length));
    // No undo stop before it: it joins the edit it puts right, where that
    // edit has not closed its step (Cut and Paste do; Delete and typing do not).
    const applied = await editor.edit((edit) => edit.replace(range, change.text), {
      undoStopBefore: false,
      undoStopAfter: false,
    });
    const now = document.getText();
    if (!applied) {
      // Another key came first. With nothing else on the way, try again
      // from the last good text.
      if (kept.expected?.text === repair.text && kept.queue.length === 0 && kept.good !== null && retries > 0) {
        kept.expected = null;
        const again = repairLevelLine(kept.good, [changeBetween(kept.good, now)]);
        if (again === null) {
          this.settle(document, kept, now);
        } else {
          await this.putBack(editor, kept, now, again, retries - 1);
        }
      }
      return;
    }
    if (now !== repair.text) {
      return;
    }
    if (repair.cursor === "before") {
      editor.selections = selections.map(
        (s) => new vscode.Selection(document.validatePosition(s.anchor), document.validatePosition(s.active)),
      );
    } else if (repair.cursor !== "editor") {
      const at = document.positionAt(repair.cursor);
      editor.selection = new vscode.Selection(at, at);
      editor.revealRange(new vscode.Range(at, at));
    }
    if (repair.kind === "kept") {
      this.explain(document);
    }
  }

  /** Why the edit did not touch the line, and where it is changed instead. */
  private explain(document: vscode.TextDocument): void {
    const line = levelLineOf(document);
    if (line === null) {
      return;
    }
    const lens = vscode.workspace.getConfiguration("editor", document).get<boolean>("codeLens", true);
    const where = lens ? `"Level: ${line.level}" above it` : `"PLL: ${line.level}" in the status bar`;
    vscode.window.setStatusBarMessage(`$(lock) PLL keeps the #level line. To change it, click ${where}.`, 5000);
  }

  /**
   * A selection that takes in the line and more starts on the line below
   * it - so Select All selects everything there is to edit.
   */
  private selected(event: vscode.TextEditorSelectionChangeEvent): void {
    const editor = event.textEditor;
    const kept = this.kept.get(editor.document.uri.toString());
    if (kept === undefined || kept.good === null) {
      return;
    }
    const line = levelLineOf(editor.document);
    let selections = event.selections;
    if (line !== null) {
      const below = new vscode.Position(line.line + 1, 0);
      let moved = false;
      selections = event.selections.map((s) => {
        if (s.start.line > line.line || s.end.line <= line.line) {
          return s;
        }
        moved = true;
        return s.isReversed ? new vscode.Selection(s.anchor, below) : new vscode.Selection(below, s.active);
      });
      if (moved) {
        editor.selections = selections;
      }
    }
    // Kept for putting back once an edit is put right; not while one is.
    if (kept.expected === null && kept.queue.length === 0) {
      kept.selections = selections;
    }
  }

  private async write(editor: vscode.TextEditor, level: Level | null): Promise<void> {
    const document = editor.document;
    const text = document.getText();
    const next = withLevel(text, level, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
    if (next === text) {
      return;
    }
    const kept = this.track(document);
    if (kept !== null) {
      kept.expected = { text: next, repair: false };
    }
    const change = lineChangeBetween(text, next);
    const range = new vscode.Range(document.positionAt(change.offset), document.positionAt(change.offset + change.length));
    const applied = await editor.edit((edit) => edit.replace(range, change.text));
    if (!applied && kept?.expected?.text === next) {
      kept.expected = null;
    }
  }

  private refresh(document: vscode.TextDocument, kept: Kept): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) {
        this.decorate(editor);
      }
    }
    if (vscode.window.activeTextEditor?.document === document) {
      this.showStatus();
    }
    const line = levelLineOf(document);
    const shown = line === null ? "" : `${line.line}:${line.level}`;
    if (shown !== kept.shown) {
      kept.shown = shown;
      this.lensesChanged.fire();
    }
  }

  private decorate(editor: vscode.TextEditor): void {
    const line = this.applies(editor.document) ? levelLineOf(editor.document) : null;
    editor.setDecorations(this.highlight, line === null ? [] : [new vscode.Range(line.line, 0, line.line, 0)]);
  }

  private showStatus(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || !this.applies(editor.document)) {
      this.status.hide();
      return;
    }
    const line = levelLineOf(editor.document);
    this.status.text = `PLL: ${line?.level ?? "raw"}`;
    this.status.tooltip =
      line === null
        ? "This file has no #level line, so it runs as plain Python. Click to give it one."
        : `This file runs at the ${line.level} level, as its #level line says. Click to change it.`;
    this.status.show();
  }

  private lenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const line = this.applies(document) ? levelLineOf(document) : null;
    if (line === null) {
      return [];
    }
    return [
      new vscode.CodeLens(new vscode.Range(line.line, 0, line.line, 0), {
        title: `$(lock) Level: ${line.level} · change`,
        tooltip: "PLL keeps this line in place. Click to change the level, or to remove the line.",
        command: "pll.changeLevel",
        arguments: [document.uri],
      }),
    ];
  }
}

/** The `#level` line's number and level, read line by line rather than from the whole text. */
function levelLineOf(document: vscode.TextDocument): { line: number; level: Level } | null {
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (text.trim().length > 0) {
      const level = headerLevel(text);
      return level === null ? null : { line, level };
    }
  }
  return null;
}

/** The editor showing `uri` - the active one first - or the active editor. */
function editorFor(uri?: vscode.Uri): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (uri === undefined) {
    return active;
  }
  const key = uri.toString();
  if (active?.document.uri.toString() === key) {
    return active;
  }
  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === key);
}

/** The picker, with the level the file is at now as the one highlighted. */
function choose(items: PickItem[], line: { level: Level } | null): Promise<PickItem | undefined> {
  const pick = vscode.window.createQuickPick<PickItem>();
  pick.title = "The level this file runs at";
  pick.placeholder = line === null ? "This file has no #level line: it runs as plain Python" : `It is at ${line.level} now`;
  pick.items = items;
  pick.activeItems = items.filter((item) => item.level !== undefined && item.level === line?.level);
  return new Promise((resolve) => {
    pick.onDidAccept(() => {
      resolve(pick.selectedItems[0]);
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
}
