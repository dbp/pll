import { parseArgs } from "node:util";
import { errorText } from "../common/errorText";

/** An option the command line takes. */
export interface CliOption {
  type: "boolean" | "string";
  short?: string;
  /** For an option that takes a value, what it needs: "a directory". */
  needs?: string;
}

export type CommandLine =
  | { values: Record<string, string | boolean | undefined>; positionals: string[] }
  | { error: string };

/**
 * Node's own parser, strictly - so `--save-images=out`, `-qv` and `--` all
 * work as they do everywhere else - with its errors said the way the rest
 * of `pll` says things: "unknown option --bogus", "-o needs a file". An
 * option's value cannot be empty: `--save-images=` names no directory.
 */
export function parseCommandLine(argv: string[], options: Record<string, CliOption>): CommandLine {
  const config = Object.fromEntries(
    Object.entries(options).map(([name, { type, short }]) => [name, short ? { type, short } : { type }]),
  );
  let line: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    line = parseArgs({ args: argv, options: config, allowPositionals: true, strict: true }) as typeof line;
  } catch (err) {
    return { error: reworded(err, options, argv) };
  }
  for (const [name, value] of Object.entries(line.values)) {
    if (value === "") {
      return { error: `${typedFlag(name, options[name], argv)} needs ${options[name]?.needs ?? "a value"}` };
    }
  }
  return line;
}

/**
 * The index of the subcommand in `argv` - its first word that is not an
 * option or an option's value - or -1 if that word is not `name`.
 */
export function subcommandIndex(argv: string[], name: string, options: Record<string, CliOption>): number {
  const takesValue = new Set<string>();
  for (const [long, option] of Object.entries(options)) {
    if (option.type !== "string") continue;
    takesValue.add(`--${long}`);
    if (option.short) takesValue.add(`-${option.short}`);
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      return argv[i + 1] === name ? i + 1 : -1;
    }
    if (!arg.startsWith("-") || arg === "-") {
      return arg === name ? i : -1;
    }
    if (takesValue.has(arg)) i++;
  }
  return -1;
}

/** The flag as it was typed: `--out` when it was, rather than its `-o`. */
function typedFlag(long: string, option: CliOption | undefined, argv: string[]): string {
  const typedLong = argv.some((arg) => arg === `--${long}` || arg.startsWith(`--${long}=`));
  return option?.short && !typedLong ? `-${option.short}` : `--${long}`;
}

function reworded(err: unknown, options: Record<string, CliOption>, argv: string[]): string {
  const message = errorText(err);
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const flag = /^Unknown option '([^']+)'/.exec(message)?.[1];
    return flag ? `unknown option ${flag}` : message;
  }
  // "Option '-o, --out <value>' argument missing", "... is ambiguous", and
  // "Option '-q, --quiet' does not take an argument".
  const named = /^Option '(?:-(\w), )?--([\w-]+)/.exec(message);
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && named) {
    const long = named[2];
    const option = options[long];
    const flag = typedFlag(long, option, argv);
    return option?.type === "string"
      ? `${flag} needs ${option.needs ?? "a value"}`
      : `${flag} does not take a value`;
  }
  return message;
}
