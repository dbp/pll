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
 * of `pll` says things: "unknown option --bogus", "-o needs a file".
 */
export function parseCommandLine(argv: string[], options: Record<string, CliOption>): CommandLine {
  const config = Object.fromEntries(
    Object.entries(options).map(([name, { type, short }]) => [name, short ? { type, short } : { type }]),
  );
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: config,
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Record<string, string | boolean | undefined>, positionals };
  } catch (err) {
    return { error: reworded(err, options) };
  }
}

function reworded(err: unknown, options: Record<string, CliOption>): string {
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
    const [, short, long] = named;
    const flag = short ? `-${short}` : `--${long}`;
    const option = options[long];
    return option?.type === "string"
      ? `${flag} needs ${option.needs ?? "a value"}`
      : `${flag} does not take a value`;
  }
  return message;
}
