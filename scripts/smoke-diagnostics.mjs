#!/usr/bin/env node
/**
 * The editor's marks for a run's findings (`src/editor/diagnostics.ts`):
 * squiggles and Problems entries, and the gutter icons - set by a run, and
 * all of a file's gone the moment the file is edited, since they describe
 * the text as it was when it ran.
 */
import { importSource } from "./lib/bundle.mjs";
import { expect, passed } from "./lib/check.mjs";

const STUB = `
export class Range {
  constructor(a, b, c, d) { Object.assign(this, { startLine: a, startCharacter: b, endLine: c, endCharacter: d }); }
}
export class Diagnostic {
  constructor(range, message, severity) { Object.assign(this, { range, message, severity }); }
}
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const OverviewRulerLane = { Right: 4 };
export const Uri = { joinPath: (base, ...parts) => base + "/" + parts.join("/") };
const listeners = { edit: [], visible: [] };
export const marks = new Map();
export const languages = {
  createDiagnosticCollection: () => ({
    set: (uri, diagnostics) => marks.set(uri.toString(), diagnostics),
    delete: (uri) => marks.delete(uri.toString()),
    dispose() {},
  }),
};
export const window = {
  visibleTextEditors: [],
  createTextEditorDecorationType: () => ({ dispose() {} }),
  onDidChangeVisibleTextEditors(cb) {
    listeners.visible.push(cb);
    return { dispose() {} };
  },
};
export const workspace = {
  onDidChangeTextDocument(cb) {
    listeners.edit.push(cb);
    return { dispose() { listeners.edit.splice(listeners.edit.indexOf(cb), 1); } };
  },
};
export function __edit(document, contentChanges) {
  for (const cb of listeners.edit) cb({ document, contentChanges });
}
`;

const { Diagnostics, vscode } = await importSource(
  'export { Diagnostics } from "./src/editor/diagnostics";\nexport * as vscode from "vscode";',
  { vscodeStub: STUB },
);

function documentAt(name, lines) {
  const uri = { toString: () => `file:///w/${name}` };
  return {
    uri,
    lineCount: lines.length,
    lineAt: (i) => ({ text: lines[i], range: new vscode.Range(i, 0, i, lines[i].length) }),
  };
}

function editorOf(document) {
  const editor = { document, gutter: null, setDecorations: (_type, ranges) => (editor.gutter = ranges) };
  return editor;
}

const finding = (line) => ({
  id: "name-error",
  errorType: "NameError",
  headline: "Python doesn't know what `x` means.",
  howToFix: [],
  fileName: "a.py",
  lineNumber: line,
  column: 6,
  nameToken: "x",
  severity: "error",
  origin: "runtime",
  level: "raw",
});

const a = documentAt("a.py", ["y = 1", "print(x)"]);
const b = documentAt("b.py", ["print(1)"]);
const editorA = editorOf(a);
const editorB = editorOf(b);
vscode.window.visibleTextEditors.push(editorA, editorB);
const diagnostics = new Diagnostics("ext");
const marked = () => vscode.marks.get(a.uri.toString())?.length ?? 0;
const typed = [{ range: new vscode.Range(0, 0, 0, 0), rangeOffset: 0, rangeLength: 0, text: "z" }];

console.log("\n[1] a run's finding: a squiggle, a Problems entry and a gutter icon");
diagnostics.setFindings(a.uri, a, [finding(2)]);
expect(marked() === 1, `one diagnostic: ${marked()}`);
expect(editorA.gutter?.length === 1, `one gutter icon: ${JSON.stringify(editorA.gutter)}`);

console.log("\n[2] the file edited: all of its marks gone");
vscode.__edit(a, typed);
expect(marked() === 0 && !vscode.marks.has(a.uri.toString()), "no diagnostics left");
expect(editorA.gutter?.length === 0, `no gutter icons left: ${JSON.stringify(editorA.gutter)}`);

console.log("\n[3] what is not an edit of it leaves them");
diagnostics.setFindings(a.uri, a, [finding(2)]);
// Only the dirty state changing.
vscode.__edit(a, []);
expect(marked() === 1 && editorA.gutter?.length === 1, "word of the dirty state is not an edit");
// Another file edited.
vscode.__edit(b, typed);
expect(marked() === 1 && editorA.gutter?.length === 1, "another file's edit is not this one's");

console.log("\n[4] once disposed, it hears no more edits");
diagnostics.dispose();
vscode.__edit(a, typed);
expect(marked() === 1, "a disposed one does nothing");

console.log(passed() ? "\nsmoke-diagnostics: ok" : "\nsmoke-diagnostics: FAILED");
if (!passed()) process.exitCode = 1;
