import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PythonRuntime } from "../run/python";
import { EXIT } from "./run";
import type { CliView } from "./view";
import { errorText } from "../core/errorText";
import { parseCommandLine, type CliOption } from "./args";

export const BUNDLE_USAGE = `pll bundle - author bundles

  pll bundle build <file.py> [-o bundle.json]

A bundle is a module a program names with a line of its own,

  #bundle <name> https://example.edu/<file>.json

and then uses by that name, with no import: functions to call whose code
the student doesn't see. Put the bundle where that address finds it.

<file.py> is the module, with the \`#level\` line it was written at: its code
starts with that level's names (\`dataclass\`, \`Callable\`) wherever it is
used. Its top-level \`test_\` functions, and an \`import pytest\`, are left out
of the bundle; everything else is in it, docstrings too.

Only bytecode is written to the bundle, so the source stays in your
repository. It is compiled by the Pyodide this package pins, so it always
matches the interpreter that will run it.

  -o, --out FILE    write here instead of stdout
`;

/** Said after a mistake in how it was run, rather than all of the usage. */
const BUNDLE_USAGE_HINT =
  "Usage: pll bundle build <file.py> [-o bundle.json]. `pll bundle --help` says more.";

interface BuildArgs {
  file?: string;
  out?: string;
  help: boolean;
  error?: string;
}

const BUILD_OPTIONS: Record<string, CliOption> = {
  out: { type: "string", short: "o", needs: "a file" },
  help: { type: "boolean", short: "h" },
};

export function parseBundleArgs(argv: string[]): BuildArgs {
  if (argv[0] === "-h" || argv[0] === "--help") {
    return { help: true };
  }
  if (argv[0] !== "build") {
    return {
      help: false,
      error: argv.length === 0 ? "bundle needs a subcommand" : `unknown bundle subcommand ${argv[0]}`,
    };
  }
  const line = parseCommandLine(argv.slice(1), BUILD_OPTIONS);
  if ("error" in line) {
    return { help: false, error: line.error };
  }
  const { values, positionals } = line;
  const args: BuildArgs = {
    file: positionals[0],
    out: values.out as string | undefined,
    help: values.help === true,
  };
  if (positionals.length > 1) {
    args.error = `unexpected extra argument ${positionals[1]}`;
  } else if (!args.help && args.file === undefined) {
    args.error = "no file given";
  } else if (args.file !== undefined && !args.file.endsWith(".py")) {
    args.error = `${args.file} is not a .py file`;
  }
  return args;
}

export async function runBundle(runtime: PythonRuntime, view: CliView, argv: string[]): Promise<number> {
  const args = parseBundleArgs(argv);
  if (args.help) {
    process.stdout.write(BUNDLE_USAGE);
    return EXIT.ok;
  }
  if (args.error !== undefined) {
    process.stderr.write(`pll: ${args.error}\n${BUNDLE_USAGE_HINT}\n`);
    return EXIT.usage;
  }

  const file = path.resolve(args.file as string);
  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (err) {
    view.problem(`pll: cannot read ${args.file}: ${errorText(err)}`);
    return EXIT.usage;
  }

  const built = await runtime.bundleBuild(source, path.basename(file));
  if (!built.ok || !built.bundle) {
    view.problem(`pll: ${built.error ?? "could not build the bundle"}`);
    return EXIT.usage;
  }
  const bundle = built.bundle;
  view.note(
    `built for Python ${bundle.built.python}, at #level ${bundle.level}: ` +
      `defines ${bundle.defines.join(", ") || "nothing"}`,
  );

  const json = JSON.stringify(bundle);
  if (args.out === undefined) {
    process.stdout.write(json + "\n");
  } else {
    await fs.writeFile(path.resolve(args.out), json + "\n", "utf8");
    view.note(`wrote ${args.out} (${json.length} bytes)`);
  }
  return EXIT.ok;
}
