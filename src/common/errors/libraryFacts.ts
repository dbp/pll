/**
 * What the explanations know about PLL's own library: the functions that
 * call one of the student's, what each passes it, which frames are the
 * reactor's, and every function's parameters.
 *
 * In one place because each fact was needed by more than one explanation,
 * and was written out in each - three copies of "the functions that call
 * yours", two of what they pass.
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
 * Frames that mean a reactor called the handler.
 *
 * There are several, because a handler is reached through whichever of
 * them is driving at the time - showing the first frame, a tick, a key.
 * They all amount to the same thing for the student, so they map to one
 * name: the value came from the reactor's state, not from any line.
 */
export const REACTOR_FRAMES = [
  "_pll_reactor_interact",
  "_pll_reactor_view",
  "_pll_reactor_step",
  "interact",
  "react",
  "tick",
  "step",
];

/**
 * Parameter names of PLL's own library functions.
 *
 * Python says `circle() missing 2 required positional arguments: 'mode'
 * and 'color'` without saying what `circle` takes, and for the student's
 * own functions `sourceFacts` reads the `def` line to fill that in. For a
 * library function there is no `def` to read: the Python source is not in
 * this bundle, and inlining 86 KB of it to answer one question about
 * argument counts is not worth it.
 *
 * So the signatures are written out here, and `smoke-explainers` checks
 * every one of them against the real `.py` files - in both directions, so
 * a renamed parameter or a new public function fails the test rather than
 * quietly producing a wrong message.
 *
 * `required` is the part with no default, which is what an arity error is
 * about; `all` includes the optional ones, which is what a student has to
 * fit a too-long call into.
 */
export interface LibrarySignature {
  required: string[];
  all: string[];
}

export const LIBRARY_SIGNATURES: Record<string, LibrarySignature> = {
  above_align: { required: ["x_place"], all: ["x_place"] },
  add_column: { required: ["name", "values_or_fn"], all: ["name", "values_or_fn"] },
  animate: { required: ["to_draw"], all: ["to_draw"] },
  bar_chart: { required: ["x", "y"], all: ["x", "y", "title"] },
  beside_align: { required: ["y_place"], all: ["y_place"] },
  big_bang: { required: ["init"], all: ["init"] },
  box_plot: { required: ["name"], all: ["name", "title"] },
  circle: { required: ["radius", "mode", "color"], all: ["radius", "mode", "color"] },
  column: { required: ["name"], all: ["name"] },
  crop: { required: ["x", "y", "width", "height", "image"], all: ["x", "y", "width", "height", "image"] },
  dot_plot: { required: ["name"], all: ["name", "title"] },
  ellipse: { required: ["width", "height", "mode", "color"], all: ["width", "height", "mode", "color"] },
  empty_scene: { required: ["width", "height"], all: ["width", "height"] },
  filter: { required: ["predicate"], all: ["predicate"] },
  flip_horizontal: { required: ["image"], all: ["image"] },
  flip_vertical: { required: ["image"], all: ["image"] },
  frame: { required: ["image"], all: ["image"] },
  freq_bar_chart: { required: ["name"], all: ["name", "title"] },
  function_plot: { required: ["f", "x_min", "x_max"], all: ["f", "x_min", "x_max", "steps", "title"] },
  handles: { required: ["name"], all: ["name"] },
  histogram: { required: ["name"], all: ["name", "bins", "bin_width", "title"] },
  image_height: { required: ["image"], all: ["image"] },
  image_width: { required: ["image"], all: ["image"] },
  labeled_dot_plot: { required: ["labels", "name"], all: ["labels", "name", "title"] },
  labeled_lr_plot: { required: ["labels", "x", "y"], all: ["labels", "x", "y", "title"] },
  labeled_scatter_plot: { required: ["labels", "x", "y"], all: ["labels", "x", "y", "title"] },
  line: { required: ["dx", "dy", "color"], all: ["dx", "dy", "color"] },
  line_chart: { required: ["x", "y"], all: ["x", "y", "title"] },
  linear_regression: { required: ["x", "y"], all: ["x", "y"] },
  load_image: { required: ["source"], all: ["source"] },
  load_table: { required: ["source"], all: ["source"] },
  lr_plot: { required: ["x", "y"], all: ["x", "y", "title"] },
  max: { required: ["name"], all: ["name"] },
  mean: { required: ["name"], all: ["name"] },
  min: { required: ["name"], all: ["name"] },
  order_by: { required: ["name"], all: ["name", "ascending"] },
  overlay_align: { required: ["x_place", "y_place"], all: ["x_place", "y_place"] },
  overlay_xy: { required: ["image1", "dx", "dy", "image2"], all: ["image1", "dx", "dy", "image2"] },
  package: { required: ["state", "message"], all: ["state", "message"] },
  pie_chart: { required: ["labels", "values"], all: ["labels", "values", "title"] },
  place_image: { required: ["image", "x", "y", "scene"], all: ["image", "x", "y", "scene"] },
  react: { required: ["event"], all: ["event"] },
  rectangle: { required: ["width", "height", "mode", "color"], all: ["width", "height", "mode", "color"] },
  regular_polygon: { required: ["side", "sides", "mode", "color"], all: ["side", "sides", "mode", "color"] },
  right_triangle: { required: ["width", "height", "mode", "color"], all: ["width", "height", "mode", "color"] },
  rotate: { required: ["angle", "image"], all: ["angle", "image"] },
  row: { required: ["index"], all: ["index"] },
  scale: { required: ["factor", "image"], all: ["factor", "image"] },
  scatter_chart: { required: ["x", "y"], all: ["x", "y", "title"] },
  scatter_plot: { required: ["x", "y"], all: ["x", "y", "title"] },
  select_columns: { required: ["names"], all: ["names"] },
  simulate_trace: { required: ["limit"], all: ["limit"] },
  square: { required: ["side", "mode", "color"], all: ["side", "mode", "color"] },
  star: { required: ["side", "mode", "color"], all: ["side", "mode", "color"] },
  star_polygon: { required: ["side", "points_count", "step", "mode", "color"], all: ["side", "points_count", "step", "mode", "color"] },
  sum: { required: ["name"], all: ["name"] },
  table: { required: ["columns", "rows"], all: ["columns", "rows"] },
  table_from_columns: { required: ["data"], all: ["data"] },
  text: { required: ["value", "size", "color"], all: ["value", "size", "color"] },
  transform_column: { required: ["name", "fn"], all: ["name", "fn"] },
  triangle: { required: ["side", "mode", "color"], all: ["side", "mode", "color"] },
  underlay_align: { required: ["x_place", "y_place"], all: ["x_place", "y_place"] },
  underlay_xy: { required: ["image1", "dx", "dy", "image2"], all: ["image1", "dx", "dy", "image2"] },
};

/** The signature of a PLL library function, or null if it has none. */
export function librarySignature(name: string): LibrarySignature | null {
  return Object.prototype.hasOwnProperty.call(LIBRARY_SIGNATURES, name)
    ? LIBRARY_SIGNATURES[name]
    : null;
}

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
