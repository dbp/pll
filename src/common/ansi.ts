export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

export function color(text: string, ...codes: ReadonlyArray<string>): string {
  if (codes.length === 0) {
    return text;
  }
  return codes.join("") + text + ANSI.reset;
}

export const CRLF = "\r\n";

/** Convert any string with `\n` newlines into terminal-safe `\r\n`. */
export function toCRLF(text: string): string {
  return text.replace(/\r\n|\r|\n/g, CRLF);
}
