import * as fs from "node:fs";
import * as path from "node:path";
import { parseCommandLine, subcommandIndex, type CliOption } from "./args";
import { runExamplar } from "./examplar";
import { createCliRuntime } from "./runtime";
import { EXIT, runFile } from "./run";
import { createStdinReader } from "./stdin";
import { CliView } from "./view";
import { errorText } from "../common/errorText";
import { PythonLostError } from "../common/runtimeErrors";
import type { PythonRuntime } from "../common/types";

declare const PLL_CLI_VERSION: string;

const USAGE = `pll - run Python with PLL's language levels, outside the editor

  pll <file.py> [options]

The level comes from the file's own \`#level\` line, exactly as in the
editor; there is deliberately no flag to override it, so a file behaves the
same everywhere.

Subcommands
  examplar build       author an Examplar bundle; see \`pll examplar --help\`

Options
  --no-tests           do not run the file's \`test_*\` functions, which
                       otherwise run once the program finishes
  --save-images <dir>  write pictures there as .svg (they cannot be drawn
                       in a terminal); without this, each one prints a note
  -q, --quiet          only the program's own output and what went wrong:
                       errors, failed tests, files not loaded or not saved
  --no-color           never use ANSI colour
  -h, --help           this message
  -V, --version        print the version

The program's own stdout is the only thing on stdout, so it can be piped;
everything PLL says about the run goes to stderr.

Exit codes
  0    ran, and any tests passed
  1    the program raised, or was stopped
  2    level checks found problems, so it was not run
  3    a test failed
  64   bad usage, or Python could not start
  130  a second Ctrl+C gave up waiting for it to stop
  141  what it printed could no longer be read (\`| head\`)
  143  it was ended by SIGTERM
A program that ends with \`sys.exit(n)\` exits with n, as it would under
\`python\`; \`sys.exit("message")\` prints the message and exits with 1.
`;

/** Said after a mistake in how \`pll\` was run, rather than all of USAGE. */
const USAGE_HINT = "Usage: pll <file.py> [options]. `pll --help` says more.";

/**
 * What Pyodide says as it loads packages. "Loading pytest, ...", "Loaded
 * ..." and their kind come with every run that has tests, and say nothing a
 * student needs, so they are not shown. A download is said once - the first
 * use of a package needs the network, and can take a while - and a package
 * that failed to load is a problem, said regardless of `--quiet`.
 */
function sayPackageNotes(runtime: PythonRuntime, view: CliView): void {
  let saidDownload = false;
  runtime.setPackageNoteHandler((text, failed) => {
    if (failed) {
      view.problem(text);
      return;
    }
    if (/^Didn't find package \S+ locally/.test(text) && !saidDownload) {
      saidDownload = true;
      view.note("Downloading packages: the first time one is used, it needs the network.");
    }
  });
}

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

const OPTIONS: Record<string, CliOption> = {
  "no-tests": { type: "boolean" },
  "save-images": { type: "string", needs: "a directory" },
  quiet: { type: "boolean", short: "q" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
};

/** What may come before \`examplar\`: the options that mean the same to it. */
const LEADING_OPTIONS: Record<string, CliOption> = {
  quiet: OPTIONS.quiet,
  "no-color": OPTIONS["no-color"],
};

export function parseArgs(argv: string[]): Args {
  const line = parseCommandLine(argv, OPTIONS);
  if ("error" in line) {
    return {
      runTests: true,
      quiet: false,
      color: colorDefault(),
      help: false,
      version: false,
      error: line.error,
    };
  }
  const { values, positionals } = line;
  const args: Args = {
    file: positionals[0],
    runTests: values["no-tests"] !== true,
    saveImagesDir: values["save-images"] as string | undefined,
    quiet: values.quiet === true,
    color: colorDefault() && values["no-color"] !== true,
    help: values.help === true,
    version: values.version === true,
  };
  if (positionals.length > 1) {
    args.error = `unexpected extra argument ${positionals[1]}`;
  } else if (!args.help && !args.version && args.file === undefined) {
    args.error = "no file given";
  } else if (args.file !== undefined && !args.file.endsWith(".py")) {
    args.error = `${args.file} is not a .py file`;
  } else if (args.saveImagesDir !== undefined && isFile(args.saveImagesDir)) {
    args.error = `--save-images needs a directory, and ${args.saveImagesDir} is a file`;
  }
  return args;
}

function isFile(at: string): boolean {
  try {
    return !fs.statSync(at).isDirectory();
  } catch {
    return false;
  }
}

export async function main(argv: string[]): Promise<number> {
  // Dispatch subcommands before flag parsing, so `examplar` is never taken
  // for a file name. Options may come first (`pll --no-color examplar
  // ...`) - and an option's value is not a subcommand: `--save-images
  // examplar hw.py` saves pictures into a folder called examplar.
  const at = subcommandIndex(argv, "examplar", OPTIONS);
  if (at !== -1) {
    const leading = parseCommandLine(argv.slice(0, at), LEADING_OPTIONS);
    if ("error" in leading) {
      process.stderr.write(`pll: ${leading.error} before examplar\n${USAGE_HINT}\n`);
      return EXIT.usage;
    }
    const view = new CliView({
      quiet: leading.values.quiet === true,
      color: colorDefault() && leading.values["no-color"] !== true,
    });
    const runtime = createCliRuntime();
    sayPackageNotes(runtime, view);
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
    process.stderr.write(`pll: ${args.error}\n${USAGE_HINT}\n`);
    return EXIT.usage;
  }

  const view = new CliView({
    saveImagesDir: args.saveImagesDir,
    quiet: args.quiet,
    color: args.color,
  });
  const runtime = createCliRuntime();
  sayPackageNotes(runtime, view);
  const reader = createStdinReader();
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
  // `pll hw.py | head -3`: once the reader has gone, nothing the program
  // prints can be read, and a print loop would never end. Leave as a
  // program killed by SIGPIPE does - quietly, with 141 - not with a stack.
  const onBrokenPipe = (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      runtime.dispose();
      process.exit(141);
    }
  };
  process.stdout.on("error", onBrokenPipe);
  process.stderr.on("error", onBrokenPipe);

  try {
    return await runFile(runtime, view, {
      file: path.resolve(args.file as string),
      runTests: args.runTests,
      stopRequested: () => interrupted,
    });
  } catch (err) {
    view.problem(`pll: ${errorText(err)}`);
    // Python stopping under the program is the program's failure, not a
    // mistake in how `pll` was run.
    return err instanceof PythonLostError ? EXIT.programError : EXIT.usage;
  } finally {
    process.off("SIGINT", onSigint);
    reader.close();
    runtime.dispose();
  }
}
