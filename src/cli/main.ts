import * as path from "node:path";
import { runExamplar } from "./examplar";
import { createCliRuntime } from "./runtime";
import { EXIT, runFile } from "./run";
import { createLineReader } from "./stdin";
import { CliView } from "./view";
import { errorText } from "../common/errorText";

declare const PLL_CLI_VERSION: string;

const USAGE = `pll - run Python with PLL's language levels, outside the editor

  pll <file.py> [options]

The level comes from the file's own \`#level\` line, exactly as in the
editor; there is deliberately no flag to override it, so a file behaves the
same everywhere.

Subcommands
  examplar build       author an Examplar bundle; see \`pll examplar --help\`

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
  0  ran, tests passed                  2  level checks blocked it
  1  the program raised or was stopped  3  a test failed
`;

/** Colour only when stderr is a terminal, and never when NO_COLOR is set. */
function colorDefault(): boolean {
  return process.stderr.isTTY === true && !process.env.NO_COLOR;
}

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
    color: colorDefault(),
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
  // Dispatch subcommands before flag parsing, so `examplar` is never taken
  // for a file name. Global flags may come first (`pll --no-color examplar
  // ...`), so look at the first non-option token rather than argv[0]. An
  // option's *value* can also be a bare token, but none of them could
  // plausibly be "examplar", so this cannot misfire.
  const firstPositional = argv.find((arg) => !arg.startsWith("-"));
  if (firstPositional === "examplar") {
    const at = argv.indexOf("examplar");
    const leading = argv.slice(0, at);
    const view = new CliView({
      quiet: leading.includes("-q") || leading.includes("--quiet"),
      color: colorDefault() && !leading.includes("--no-color"),
    });
    const runtime = createCliRuntime();
    try {
      return await runExamplar(runtime, view, argv.slice(at + 1));
    } catch (err) {
      view.problem(`pll: ${errorText(err)}`);
      return EXIT.usage;
    } finally {
      runtime.dispose();
    }
  }

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
      stopRequested: () => interrupted,
    });
  } catch (err) {
    view.problem(`pll: ${errorText(err)}`);
    return EXIT.usage;
  } finally {
    process.off("SIGINT", onSigint);
    reader.close();
    runtime.dispose();
  }
}
