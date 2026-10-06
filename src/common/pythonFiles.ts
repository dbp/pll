/**
 * The names PLL's Python files show in a traceback, of the form `<pll:...>`,
 * so a frame says which part of PLL it is in - a library a student called,
 * or PLL's own machinery. `<...>` names are never the student's
 * (`_pll_is_students`). Apart from `pythonSources.ts`, which holds the
 * files themselves, so a module can name them without bundling them.
 */

/** The libraries. */
export const PLL_LIBRARY_FILES = {
  image: "<pll:image>",
  table: "<pll:table>",
  reactor: "<pll:reactor>",
  examplar: "<pll:examplar>",
} as const;

/** The install step, run after the libraries. */
export const PLL_INSTALL_FILE = "<pll:install>";

/** A bootstrap file, by its name in `src/common/bootstrap/`. */
export function bootstrapFile(name: string): string {
  return `<pll:bootstrap/${name}>`;
}
