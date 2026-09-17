import * as path from "node:path";
import { createCliRuntime } from "./runtime";
import { EXIT, runFile } from "./run";
import { createLineReader } from "./stdin";
import { CliView } from "./view";

declare const PLL_CLI_VERSION: string;

const USAGE = `pll - run Python with PLL's language levels, outside the editor

  pll <file.py> [options]

The level comes from the file's own \`#level\` line, exactly as in the
editor; there is deliberately no flag to override it, so a file behaves the
same everywhere.

Options
  --no-tests           do not run the file's \`test_*\` functions first
  --save-images <dir>  write pictures there as .svg (they cannot be drawn
                       in a terminal); without this, each one prints a note
  -q, --quiet          only the program's own output
  --no-color           never use ANSI colour
  -h, --help           this message
  -v, --version        print the version

The program's own stdout is the only thing on stdout, so it can be piped;
everything PLL says about the run goes to stderr.

Exit codes
  0  ran, tests passed        2  level checks blocked it
  1  the program raised       3  a test failed
`;

interface Args {
  file?: string;
  runTests: boolean;
  saveImagesDir?: string;
  quiet: boolean;
  color: boolean;
  help: boolean;
  version: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    runTests: true,
    quiet: false,
    // Colour only when stderr is a terminal, and never when NO_COLOR is set.
    color: process.stderr.isTTY === true && !process.env.NO_COLOR,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-tests") args.runTests = false;
    else if (arg === "-q" || arg === "--quiet") args.quiet = true;
    else if (arg === "--no-color") args.color = false;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "-v" || arg === "--version") args.version = true;
    else if (arg === "--save-images") {
      const dir = argv[++i];
      if (dir === undefined) {
        args.error = "--save-images needs a directory";
        return args;
      }
      args.saveImagesDir = dir;
    } else if (arg.startsWith("-")) {
      args.error = `unknown option ${arg}`;
      return args;
    } else if (args.file === undefined) {
      args.file = arg;
    } else {
      args.error = `unexpected extra argument ${arg}`;
      return args;
    }
  }
  if (!args.help && !args.version && args.file === undefined) {
    args.error = "no file given";
  }
  if (args.file !== undefined && !args.file.endsWith(".py")) {
    args.error = `${args.file} is not a .py file`;
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }
  if (args.version) {
    process.stdout.write(PLL_CLI_VERSION + "\n");
    return EXIT.ok;
  }
  if (args.error !== undefined) {
    process.stderr.write(`pll: ${args.error}\n\n${USAGE}`);
    return EXIT.usage;
  }

  const view = new CliView({
    saveImagesDir: args.saveImagesDir,
    quiet: args.quiet,
    color: args.color,
  });
  const runtime = createCliRuntime();
  const reader = createLineReader();
  runtime.setStdinHandler(() => reader.read());

  // Ctrl+C asks Python to stop, the way the panel's Stop button does. A
  // second one gives up and leaves, so a program that swallows
  // KeyboardInterrupt cannot trap the terminal.
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) {
      process.stderr.write("\npll: giving up.\n");
      process.exit(130);
    }
    interrupted = true;
    if (!runtime.interrupt()) {
      process.stderr.write("\npll: cannot interrupt; press Ctrl+C again to quit.\n");
    }
  };
  process.on("SIGINT", onSigint);

  try {
    return await runFile(runtime, view, {
      file: path.resolve(args.file as string),
      runTests: args.runTests,
    });
  } catch (err) {
    view.problem(`pll: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.usage;
  } finally {
    process.off("SIGINT", onSigint);
    reader.close();
    runtime.dispose();
  }
}
