import { headerLevel, type Level } from "./level";

/**
 * A file's `#level` line, as the editor keeps it: the first non-blank line,
 * when it names a level (`parseLevel`'s rule). Offsets are into the text it
 * was found in.
 */
export interface LevelLine {
  /** 0-based. */
  line: number;
  /** Where the line starts. */
  start: number;
  /** Where its text ends, before the line break. */
  end: number;
  /** Where the next line starts: past the line break, or `end` on the last line. */
  next: number;
  /** The line as written, without its line break. */
  text: string;
  level: Level;
}

/** One change an edit made, as VS Code reports it: into the text before it. */
export interface TextChange {
  offset: number;
  /** How many characters it replaced. */
  length: number;
  text: string;
}

/**
 * The text a `#level` line has to be kept in, after an edit that did not
 * leave it as it was. `kind` is `"kept"` when the line is put back, and
 * `"replaced"` when a pasted program's own `#level` line takes its place.
 * `cursor` is where the cursor goes: an offset into `text`, `"before"` for
 * the selections from before the edit - it did nothing a student could see -
 * or `"editor"` to leave it where the editor puts it.
 */
export interface LevelLineRepair {
  text: string;
  kind: "kept" | "replaced";
  cursor: number | "before" | "editor";
}

export function findLevelLine(source: string): LevelLine | null {
  const first = firstLine(source);
  const level = first === null ? null : headerLevel(first.text);
  return first === null || level === null ? null : { ...first, level };
}

/** The first line that is not blank, or null. */
function firstLine(source: string): Omit<LevelLine, "level"> | null {
  let start = 0;
  for (let line = 0; ; line++) {
    const newline = source.indexOf("\n", start);
    const next = newline < 0 ? source.length : newline + 1;
    let end = newline < 0 ? source.length : newline;
    if (end > start && source[end - 1] === "\r") {
      end -= 1;
    }
    const text = source.slice(start, end);
    if (text.trim().length > 0) {
      return { line, start, end, next, text };
    }
    if (newline < 0) {
      return null;
    }
    start = next;
  }
}

/**
 * `source` with a `#level` line naming `level` - or, for null, with none.
 * A first line that tries to be one, like `#level begginer`, is the one
 * changed or taken out; with none, the line goes on top, with an empty line
 * under it as a new file's has. Taking the line out takes an empty line
 * under it too.
 */
export function withLevel(source: string, level: Level | null, eol: string): string {
  const first = firstLine(source);
  const header = first !== null && /^\s*#\s*level\b/.test(first.text) ? first : null;
  if (level === null) {
    if (header === null) {
      return source;
    }
    const blank = /^[ \t]*\r?\n/.exec(source.slice(header.next));
    return source.slice(0, header.start) + source.slice(header.next + (blank?.[0].length ?? 0));
  }
  const written = `#level ${level}`;
  if (header !== null) {
    return source.slice(0, header.start) + written + source.slice(header.end);
  }
  if (first === null) {
    return written + eol;
  }
  return written + eol + (first.start > 0 ? "" : eol) + source;
}

/** The text `changes` make of `before`: they do not overlap, in any order. */
export function applyChanges(before: string, changes: readonly TextChange[]): string {
  let text = before;
  for (const change of [...changes].sort((a, b) => b.offset - a.offset)) {
    text = text.slice(0, change.offset) + change.text + text.slice(change.offset + change.length);
  }
  return text;
}

/** One change that turns `before` into `after`: what differs between them. */
export function changeBetween(before: string, after: string): TextChange {
  const most = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < most && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < most - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  return { offset: prefix, length: before.length - prefix - suffix, text: after.slice(prefix, after.length - suffix) };
}

/**
 * One change that turns `before` into `after`, in whole lines: the lines
 * that differ, between the ones the two share at the start and at the end.
 * VS Code's editor tokenizes some edits that start and end inside lines
 * wrongly ("Token length and text length do not match"), so PLL's own
 * edits replace whole lines.
 */
export function lineChangeBetween(before: string, after: string): TextChange {
  const old = linesOf(before);
  const now = linesOf(after);
  let top = 0;
  while (top < old.length && top < now.length && old[top] === now[top]) {
    top++;
  }
  let bottom = 0;
  while (
    bottom < old.length - top &&
    bottom < now.length - top &&
    old[old.length - 1 - bottom] === now[now.length - 1 - bottom]
  ) {
    bottom++;
  }
  const length = (lines: string[], from: number, to: number) => lines.slice(from, to).join("").length;
  const offset = length(old, 0, top);
  return {
    offset,
    length: length(old, top, old.length - bottom),
    text: after.slice(offset, after.length - length(now, now.length - bottom, now.length)),
  };
}

/** `text`'s lines, each with its line break. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * What an edit of `before` - which has a `#level` line - has to become for
 * that line to stay its first line, exactly as written; null when the edit
 * already leaves it so.
 *
 * Whatever the edit did to the rest of the file stands. What it took out
 * of the line is put back, and what it put into the line, or above it,
 * goes on the line below - so typing at the top of the file, or pasting
 * there, keeps everything typed. A program pasted in with its own `#level`
 * line, straight under this one or over it, brings that line instead: it
 * is the level the program was written for.
 */
export function repairLevelLine(before: string, changes: readonly TextChange[]): LevelLineRepair | null {
  const kept = findLevelLine(before);
  if (kept === null || changes.length === 0) {
    return null;
  }
  const after = applyChanges(before, changes);
  if (after === before) {
    return null;
  }
  const now = findLevelLine(after);
  // Nothing put into the line or above it, and the line as it was - so an
  // empty line under it can be deleted from its start.
  const intoOrAbove = changes.some((c) => c.offset <= kept.end && c.text !== "");
  if (!intoOrAbove && now !== null && now.text === kept.text) {
    return programBelow(after, now, changes, kept.next);
  }

  // Split each change between the line, what is above it, and what is below.
  const eol = kept.next > kept.end ? before.slice(kept.end, kept.next) : lineBreakOf(before);
  let above = "";
  let moved = "";
  let below = "";
  let from = 0;
  let belowFrom = kept.next;
  let collapsed = false;
  for (const change of [...changes].sort((a, b) => a.offset - b.offset)) {
    const end = change.offset + change.length;
    if (change.offset < kept.start) {
      above += before.slice(from, change.offset);
      from = Math.min(end, kept.start);
    }
    // At the line's end is in it, also when it is the last line.
    if (change.offset < kept.next || change.offset === kept.end) {
      moved += change.text;
    } else {
      below += before.slice(belowFrom, change.offset) + change.text;
      belowFrom = end;
      continue;
    }
    if (end > kept.next) {
      belowFrom = end;
      collapsed = true;
    }
  }
  above += before.slice(from, kept.start);
  below += before.slice(belowFrom);

  // The line itself, moved by the edit - a line moved above it, or it moved
  // down past one - is this line, and not a second one.
  moved = withoutLine(moved, kept.text);
  if (findLevelLine(moved) !== null) {
    // A program with its own `#level` line, pasted at the top or over
    // everything.
    return result(after, above + joined(moved, below, eol), "replaced", "editor");
  }
  const head = above + kept.text + (kept.next > kept.end || moved !== "" || below !== "" ? eol : "");
  const separator = moved !== "" && !endsWithBreak(moved) && below !== "" && !startsWithBreak(below) ? eol : "";
  const text = head + moved + separator + below;
  if (text === before) {
    return result(after, text, "kept", "before");
  }
  const cursor = moved !== "" ? head.length + moved.length : collapsed ? head.length : "before";
  return result(after, text, "kept", cursor);
}

/**
 * With the line as it was: a program pasted straight under it with a
 * `#level` line of its own - as Select All and Paste do, the selection
 * starting below this line - brings that line in place of this one. The
 * pasted line has to have come in whole: one typed into, character by
 * character, does not.
 */
function programBelow(
  after: string,
  line: LevelLine,
  changes: readonly TextChange[],
  next: number,
): LevelLineRepair | null {
  const pasted = changes.find((c) => c.offset === next && findLevelLine(c.text) !== null);
  if (pasted === undefined) {
    return null;
  }
  return result(after, after.slice(0, line.start) + after.slice(line.next), "replaced", "editor");
}

function result(
  after: string,
  text: string,
  kind: LevelLineRepair["kind"],
  cursor: LevelLineRepair["cursor"],
): LevelLineRepair | null {
  return text === after ? null : { text, kind, cursor };
}

/** `text` with the first whole line that reads `line` taken out, with one line break. */
function withoutLine(text: string, line: string): string {
  const lines = text.split(/(\r?\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    if (lines[i] === line) {
      if (i + 1 < lines.length) {
        lines.splice(i, 2);
      } else if (i > 0) {
        lines.splice(i - 1, 2);
      } else {
        lines.splice(i, 1);
      }
      return lines.join("");
    }
  }
  return text;
}

/** `top` and then `rest`, on lines of their own. */
function joined(top: string, rest: string, eol: string): string {
  return top + (top !== "" && rest !== "" && !endsWithBreak(top) && !startsWithBreak(rest) ? eol : "") + rest;
}

function lineBreakOf(text: string): string {
  const newline = text.indexOf("\n");
  return newline > 0 && text[newline - 1] === "\r" ? "\r\n" : "\n";
}

function endsWithBreak(text: string): boolean {
  return text.endsWith("\n");
}

function startsWithBreak(text: string): boolean {
  return text.startsWith("\n") || text.startsWith("\r\n");
}
