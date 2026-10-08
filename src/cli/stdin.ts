/**
 * The program's stdin, for `input()` and `sys.stdin.read()`.
 *
 * Read as it comes - bytes, not lines - so a program reads exactly what it
 * was given: `printf 'a'` is "a", with no newline added; a file piped in is
 * all of it. The Pyodide worker blocks on a SharedArrayBuffer while this
 * resolves, so the prompt has already been printed by the time we are
 * asked. Null is the end of stdin, which Python turns into `EOFError` in
 * `input()` - what a piped stdin running dry should do, and what Ctrl+D does
 * interactively.
 */
export interface StdinReader {
  read(): Promise<Uint8Array | null>;
  close(): void;
}

export function createStdinReader(): StdinReader {
  let started = false;
  let ended = false;
  const waiting: ((chunk: Uint8Array | null) => void)[] = [];
  const buffered: Uint8Array[] = [];

  const onData = (chunk: Buffer) => {
    const next = waiting.shift();
    if (next) next(chunk);
    else buffered.push(chunk);
  };
  const onEnd = () => {
    ended = true;
    while (waiting.length > 0) waiting.shift()?.(null);
  };

  // Only once the program reads: a program that never does must not hold
  // the terminal's stdin open, or keep Node running after it.
  function start(): void {
    if (started) return;
    started = true;
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onEnd);
  }

  return {
    read() {
      const chunk = buffered.shift();
      if (chunk) {
        return Promise.resolve(chunk);
      }
      if (ended) {
        return Promise.resolve(null);
      }
      start();
      return new Promise<Uint8Array | null>((resolve) => waiting.push(resolve));
    },
    close() {
      ended = true;
      if (started) {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        process.stdin.off("error", onEnd);
        process.stdin.pause();
      }
    },
  };
}
