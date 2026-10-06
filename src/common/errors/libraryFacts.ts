/**
 * What the explanations know about PLL's own library that its definitions
 * do not say: the functions that call one of the student's, what each
 * passes it, and what to add to an arity error about one.
 *
 * In one place because each fact is needed by more than one explanation.
 */

/**
 * The library functions that call a function the student passes them, and
 * what they call it with. `each` and `param` are for the table methods,
 * whose function decides about one row or value at a time.
 *
 * The distinction that matters is `transform_column`, which passes one
 * *value* from a column, against `filter` and `add_column`, which pass a
 * whole row. Confusing the two is the commonest reason one of these
 * functions' annotations fails.
 */
export const FUNCTION_TAKERS: Record<
  string,
  { calls: string; each?: string; param?: string; keeps?: string }
> = {
  filter: {
    calls: "`filter` calls your function with one row at a time",
    each: "each row",
    param: "r: dict",
    keeps: "keeps the rows where it returns `True`",
  },
  transform_column: {
    calls: "`transform_column` calls your function with one *value* from the column, not a row",
    each: "each value in the column",
    param: "v",
    keeps: "puts what it returns in place of the value",
  },
  add_column: {
    calls: "`add_column` calls your function with one row at a time",
    each: "each row",
    param: "r: dict",
    keeps: "puts what it returns in the new column",
  },
  animate: { calls: "`animate` calls your function with the tick count, a number" },
  big_bang: { calls: "`big_bang` calls your handlers with the state" },
};

/** The names of `FUNCTION_TAKERS`. */
export const FUNCTION_TAKER_NAMES = Object.keys(FUNCTION_TAKERS);

/** A reactor's handlers, which are given a function by keyword: `to_draw=draw`. */
export const HANDLER_KEYWORDS = ["to_draw", "on_tick", "stop_when", "on_key", "on_mouse", "on_receive"];

/**
 * Extra lines for an arity error on a library function, where knowing the
 * parameter names is not enough.
 *
 * `table` is the one that matters: the shape of its two arguments - names
 * first, then every row inside one more list - is what goes wrong, and
 * "takes 2 arguments (columns and rows)" does not say it.
 */
export const LIBRARY_HINTS: Record<string, string[]> = {
  table: [
    'The column names come first, as a list of strings, then all the rows inside one more list: `table(["month", "riders"], [["Jan", 1], ["Feb", 2]])`.',
  ],
  table_from_columns: [
    "`table_from_columns` takes one dictionary: `table_from_columns({\"month\": [...], \"riders\": [...]})`.",
  ],
};

/** The extra lines for `name`, or an empty list. */
export function libraryHint(name: string): string[] {
  return Object.prototype.hasOwnProperty.call(LIBRARY_HINTS, name)
    ? LIBRARY_HINTS[name]
    : [];
}
