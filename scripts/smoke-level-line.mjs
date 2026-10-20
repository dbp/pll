#!/usr/bin/env node
/**
 * The `#level` line the editor keeps in place (`src/core/levelLine.ts`):
 * every edit a student can make near it, as the change VS Code reports, and
 * the text and cursor the line is kept with. The editor's part - applying
 * it, in one undo step - is `test-web:level`'s.
 */
import { importSource } from "./lib/bundle.mjs";
import { expect, passed } from "./lib/check.mjs";

const { applyChanges, changeBetween, lineChangeBetween, findLevelLine, repairLevelLine, withLevel, headerLevel, parseLevel } =
  await importSource(
    'export { applyChanges, changeBetween, lineChangeBetween, findLevelLine, repairLevelLine, withLevel } from "./src/core/levelLine";\n' +
      'export { headerLevel, parseLevel } from "./src/core/level";',
  );

const insert = (offset, text) => ({ offset, length: 0, text });
const remove = (from, to) => ({ offset: from, length: to - from, text: "" });
const replace = (from, to, text) => ({ offset: from, length: to - from, text });

const FILE = "#level beginner\nprint(1)\nprint(2)\n";
const END = FILE.length;
const BELOW = "#level beginner\n".length;

console.log("\n[1] which line is the `#level` line");
{
  const cases = [
    ["#level beginner", "beginner"],
    ["  #level  advanced  ", "advanced"],
    ["# level raw", "raw"],
    ["#level Beginner", null],
    ["#levelbeginner", null],
    ["#level begginer", null],
    ["# my lab", null],
  ];
  for (const [line, level] of cases) {
    expect(headerLevel(line) === level, `${JSON.stringify(line)}: ${headerLevel(line)}, not ${level}`);
  }
  for (const [source, level] of [["\n\n#level intermediate\nx = 1\n", "intermediate"], ["# lab\n#level beginner\n", "raw"], ["", "raw"]]) {
    expect(parseLevel(source) === level, `parseLevel(${JSON.stringify(source)}): ${parseLevel(source)}`);
  }
  const found = findLevelLine("\r\n#level beginner\r\nx = 1\r\n");
  expect(
    found?.line === 1 && found.start === 2 && found.end === 17 && found.next === 19 && found.text === "#level beginner",
    `a CRLF file, under a blank line: ${JSON.stringify(found)}`,
  );
  const last = findLevelLine("#level raw");
  expect(last?.end === 10 && last.next === 10, `a file that is only the line: ${JSON.stringify(last)}`);
  expect(findLevelLine("# lab\n#level beginner\n") === null && findLevelLine("") === null, "none under a comment, or in an empty file");
  console.log(`    ${cases.length} lines, three files`);
}

console.log("\n[2] what an edit leaves of the line, and the cursor");
{
  // [what, the text, the changes, the text it is kept as (null: as the edit
  // left it), and the cursor].
  const CASES = [
    ["an edit below it", FILE, [insert(BELOW, "x")], null],
    ["Select All and Delete, from the line below", FILE, [remove(BELOW, END)], null],
    ["Select All and Delete, the line too", FILE, [remove(0, END)], "#level beginner\n", BELOW],
    ["Select All and Paste, the line too", FILE, [replace(0, END, "print(9)\n")], "#level beginner\nprint(9)\n", 25],
    ["a program pasted over everything, with its own line", FILE, [replace(0, END, "#level advanced\nx = 1\n")], null],
    ["a program pasted under the line, with its own line", FILE, [replace(BELOW, END, "#level advanced\nx = 1\n")], "#level advanced\nx = 1\n", "editor"],
    ["a program pasted under it, with the same line", FILE, [replace(BELOW, END, "#level beginner\nx = 1\n")], "#level beginner\nx = 1\n", "editor"],
    ["a `#level` line typed under it", FILE, [insert(BELOW, "#")], null],
    ["typing at its end", FILE, [insert(15, "x")], "#level beginner\nx\nprint(1)\nprint(2)\n", 17],
    ["typing at its start", FILE, [insert(0, "x")], "#level beginner\nx\nprint(1)\nprint(2)\n", 17],
    ["typing inside it", FILE, [insert(10, "x")], "#level beginner\nx\nprint(1)\nprint(2)\n", 17],
    ["Enter at its start", FILE, [insert(0, "\n")], "#level beginner\n\nprint(1)\nprint(2)\n", 17],
    ["Enter at its end", FILE, [insert(15, "\n")], null],
    ["Backspace at its end", FILE, [remove(14, 15)], FILE, "before"],
    ["Delete inside it", FILE, [remove(7, 8)], FILE, "before"],
    ["joining the next line onto it", FILE, [remove(15, 16)], FILE, "before"],
    ["deleting an empty line under it, from that line's start", "#level beginner\n\nprint(1)\n", [remove(15, 16)], null],
    ["deleting the line (Ctrl+Shift+K)", FILE, [remove(0, BELOW)], FILE, "before"],
    ["moving the next line above it (Alt+Up)", FILE, [replace(0, 24, "print(1)\n#level beginner")], FILE, "before"],
    ["pasting at the top of the file", FILE, [insert(0, "import math\n")], "#level beginner\nimport math\nprint(1)\nprint(2)\n", 28],
    ["pasting a program at the top, with its own line", FILE, [insert(0, "#level advanced\nx = 1\n")], "#level advanced\nx = 1\nprint(1)\nprint(2)\n", "editor"],
    ["pasting over its level's name", FILE, [replace(7, 15, "intermediate")], "#level beginner\nintermediate\nprint(1)\nprint(2)\n", 28],
    ["pasting the same name over it", FILE, [replace(7, 15, "beginner")], null],
    ["two cursors, one at its end", FILE, [insert(15, "x"), insert(24, "x")], "#level beginner\nx\nprint(1)x\nprint(2)\n", 17],
    ["a CRLF file, all deleted", "#level beginner\r\nprint(1)\r\n", [remove(0, 27)], "#level beginner\r\n", 17],
    ["a CRLF file, typing at its end", "#level beginner\r\nprint(1)\r\n", [insert(15, "x")], "#level beginner\r\nx\r\nprint(1)\r\n", 18],
    ["a file that is only the line, typing at its end", "#level beginner", [insert(15, "x")], "#level beginner\nx", 17],
    ["a file that is only the line, all deleted", "#level beginner", [remove(0, 15)], "#level beginner", "before"],
    ["typing on a blank line above it", "\n\n#level beginner\nprint(1)\n", [insert(0, "x")], "\n\n#level beginner\nx\nprint(1)\n", 19],
    ["deleting a blank line above it", "\n\n#level beginner\nprint(1)\n", [remove(0, 1)], null],
    ["a file without the line", "print(1)\n", [remove(0, 9)], null],
    ["a file whose first line is not one", "# lab\n#level beginner\n", [remove(0, 6)], null],
  ];
  for (const [label, before, changes, want, cursor] of CASES) {
    const got = repairLevelLine(before, changes);
    // A pasted program's own line, or this one put back.
    const kind = cursor === "editor" ? "replaced" : "kept";
    const ok = want === null ? got === null : got?.text === want && got.cursor === cursor && got.kind === kind;
    expect(ok, `${label}: ${JSON.stringify(got)}, not ${JSON.stringify(want === null ? null : { text: want, kind, cursor })}`);
    // What the line is kept as is always a file whose `#level` line is
    // there - this one, or one the edit brought.
    const text = got?.text ?? applyChanges(before, changes);
    if (findLevelLine(before) !== null) {
      expect(findLevelLine(text) !== null, `${label}: no \`#level\` line left: ${JSON.stringify(text)}`);
    }
  }
  console.log(`    ${CASES.length} edits`);
}

console.log("\n[3] the picker's edits: a level for the line, a line for a file, and no line");
{
  const CASES = [
    ["another level", FILE, "advanced", "#level advanced\nprint(1)\nprint(2)\n"],
    ["raw, written out", FILE, "raw", "#level raw\nprint(1)\nprint(2)\n"],
    ["a line for a file with none", "print(1)\n", "beginner", "#level beginner\n\nprint(1)\n"],
    ["a line for an empty file", "", "beginner", "#level beginner\n"],
    ["a line for a file that starts blank", "\nprint(1)\n", "intermediate", "#level intermediate\n\nprint(1)\n"],
    ["a line for a CRLF file", "print(1)\r\n", "beginner", "#level beginner\r\n\r\nprint(1)\r\n", "\r\n"],
    ["a misspelt line, mended", "#level begginer\nprint(1)\n", "beginner", "#level beginner\nprint(1)\n"],
    ["a comment first: a line above it", "# lab 1\nprint(1)\n", "beginner", "#level beginner\n\n# lab 1\nprint(1)\n"],
    ["no line, and the empty line under it", "#level beginner\n\nprint(1)\n", null, "print(1)\n"],
    ["no line, straight above code", FILE, null, "print(1)\nprint(2)\n"],
    ["no line, in a file that is only the line", "#level beginner", null, ""],
    ["no line, where there was none", "print(1)\n", null, "print(1)\n"],
  ];
  for (const [label, source, level, want, eol = "\n"] of CASES) {
    const got = withLevel(source, level, eol);
    expect(got === want, `${label}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  }
  console.log(`    ${CASES.length} files`);
}

console.log("\n[4] edits that come too fast to keep apart are read as one, from the last good text");
{
  const good = FILE;
  const typed = "#level beginnerxy\nprint(1)\nprint(2)\n";
  const change = changeBetween(good, typed);
  expect(change.offset === 15 && change.length === 0 && change.text === "xy", `the change: ${JSON.stringify(change)}`);
  const got = repairLevelLine(good, [change]);
  expect(got?.text === "#level beginner\nxy\nprint(1)\nprint(2)\n" && got.cursor === 18 && got.kind === "kept", `kept: ${JSON.stringify(got)}`);
  const swapped = changeBetween("abc", "aXc");
  expect(swapped.offset === 1 && swapped.length === 1 && swapped.text === "X", `a replacement: ${JSON.stringify(swapped)}`);
  console.log("    two keys typed into the line before the first was put right");
}

console.log("\n[5] PLL's own edits replace whole lines");
{
  const CASES = [
    // The old line taken out from under a pasted one: the line, not
    // "beginner\n#level " from the middle of one to the middle of the next.
    ["#level beginner\n#level intermediate\nx = 1\n", "#level intermediate\nx = 1\n"],
    ["#level beginnerx\nprint(1)\n", "#level beginner\nx\nprint(1)\n"],
    ["#level beginne\nprint(1)\n", "#level beginner\nprint(1)\n"],
    ["#level beginner\r\nx\r\n", "#level advanced\r\nx\r\n"],
    ["a\nb", "a\nc"],
    ["", "#level beginner\n"],
    ["x = 1\n", ""],
  ];
  for (const [before, after] of CASES) {
    const change = lineChangeBetween(before, after);
    const starts = change.offset === 0 || before[change.offset - 1] === "\n";
    const end = change.offset + change.length;
    const ends = end === before.length || before[end - 1] === "\n";
    expect(
      applyChanges(before, [change]) === after && starts && ends,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}: ${JSON.stringify(change)}`,
    );
  }
  const taken = lineChangeBetween(CASES[0][0], CASES[0][1]);
  expect(taken.offset === 0 && taken.length === 16 && taken.text === "", `the old line, whole: ${JSON.stringify(taken)}`);
  console.log(`    ${CASES.length} edits`);
}

console.log(passed() ? "\nALL SMOKE TESTS PASSED" : "\nFAILED");
if (!passed()) process.exitCode = 1;
