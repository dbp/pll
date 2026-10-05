/**
 * Small pieces of wording every explanation uses.
 */

/**
 * Plain-language words for the types a beginner course uses, without an
 * article. The one table every explanation uses, so no two of them can name
 * a type differently.
 */
const TYPE_WORDS: Record<string, string> = {
  int: "whole number",
  float: "number",
  complex: "complex number",
  str: "string",
  bool: "`True` or `False`",
  bytes: "bytes",
  list: "list",
  dict: "dictionary",
  set: "set",
  tuple: "tuple",
  range: "range",
  function: "function",
  None: "`None`",
  NoneType: "`None`",
};

/**
 * The words for a type: "whole number" - or, with `article`, "a whole
 * number". Undefined for a type with no plain name, such as a class the
 * student wrote. Phrases that are not a noun ("`True` or `False`", "bytes")
 * never take an article.
 */
export function typeWords(type: string, { article = false } = {}): string | undefined {
  const words = TYPE_WORDS[type];
  if (words === undefined || !article || words.startsWith("`") || words === "bytes") {
    return words;
  }
  return `a ${words}`;
}

/** "1 argument", "2 arguments". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The text as a sentence: trimmed, and ending in a full stop if it had none. */
export function punctuated(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
