import * as readline from "node:readline";

/**
 * Line reader for `input()`.
 *
 * The Pyodide worker blocks on a SharedArrayBuffer while this resolves, so
 * it behaves the same as the interactions panel: the prompt has already been
 * printed by the time we are asked for a line. Returning null is EOF, which
 * Python turns into `EOFError` - which is what a piped stdin running dry
 * should do, and what Ctrl+D does interactively.
 */
export interface LineReader {
  read(): Promise<string | null>;
  close(): void;
}

export function createLineReader(): LineReader {
  let rl: readline.Interface | null = null;
  let closed = false;
  const pending: ((line: string | null) => void)[] = [];
  const buffered: string[] = [];

  function ensure(): readline.Interface {
    if (rl) return rl;
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      const next = pending.shift();
      if (next) next(line);
      else buffered.push(line);
    });
    const finish = () => {
      closed = true;
      while (pending.length > 0) pending.shift()?.(null);
    };
    rl.on("close", finish);
    process.stdin.on("end", finish);
    return rl;
  }

  return {
    read() {
      if (buffered.length > 0) {
        return Promise.resolve(buffered.shift() ?? null);
      }
      if (closed) {
        return Promise.resolve(null);
      }
      ensure();
      return new Promise<string | null>((resolve) => pending.push(resolve));
    },
    close() {
      closed = true;
      rl?.close();
      rl = null;
    },
  };
}
