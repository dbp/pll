import * as vscode from "vscode";
import { errorText } from "./errorText";
import { showWarning } from "./notify";

function copyRanges(editor: vscode.TextEditor): vscode.Range[] {
  return editor.selections.map((sel) =>
    sel.isEmpty
      ? editor.document.lineAt(sel.active.line).rangeIncludingLineBreak
      : new vscode.Range(sel.start, sel.end),
  );
}

function textForRanges(editor: vscode.TextEditor, ranges: vscode.Range[]): string {
  return ranges.map((range) => editor.document.getText(range)).join("");
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await vscode.env.clipboard.writeText(text);
  } catch (err) {
    const message = errorText(err);
    void showWarning(`copy failed (${message}). Allow clipboard access for this site.`);
  }
}

export async function editorCopy(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const text = textForRanges(editor, copyRanges(editor));
  await writeClipboard(text);
  vscode.window.setStatusBarMessage(`PLL copied ${text.length} characters`, 2500);
}

export async function editorCut(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const ranges = copyRanges(editor);
  await writeClipboard(textForRanges(editor, ranges));
  const ordered = [...ranges].sort((a, b) => {
    const start = b.start.compareTo(a.start);
    return start !== 0 ? start : b.end.compareTo(a.end);
  });
  await editor.edit((edit) => {
    for (const range of ordered) {
      edit.delete(range);
    }
  });
}

export async function editorPaste(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  let text = "";
  try {
    text = await vscode.env.clipboard.readText();
  } catch (err) {
    const message = errorText(err);
    void showWarning(`paste failed (${message}). Allow clipboard access for this site.`);
    return;
  }
  if (text.length === 0) {
    return;
  }
  await editor.edit((edit) => {
    for (const sel of editor.selections) {
      if (sel.isEmpty) {
        edit.insert(sel.active, text);
      } else {
        edit.replace(sel, text);
      }
    }
  });
  vscode.window.setStatusBarMessage(`PLL pasted ${text.length} characters`, 2500);
}
