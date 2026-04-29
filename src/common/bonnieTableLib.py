# Bonnie table library.
#
# A small, immutable, Pyret-style table abstraction. Internally a `Table`
# stores its data column-by-column (a dict of name -> list-of-values) so
# column transforms and aggregations are O(rows) and don't allocate row
# dicts unless asked. Every operation returns a new `Table`; nothing
# mutates.
#
# Public surface (all method-based, so beginners never collide with
# Python built-ins like `filter`, `sum`, `min`, `max`):
#
#   Construction:
#     table(columns, rows)            list-of-rows constructor
#     table_from_columns(d)           dict-of-columns constructor
#
#   Inspection:
#     t.columns()                     -> list[str]
#     t.length() / len(t)             -> int
#     t.column(name)                  -> list of values
#     t.row(index)                    -> dict
#     t.rows()                        -> list[dict]
#
#   Functional ops (return Table):
#     t.filter(predicate)             keep rows where predicate(row) is truthy
#     t.transform_column(name, fn)    fn(value) -> new value
#     t.add_column(name, vs_or_fn)    vs_or_fn: list of values OR fn(row)
#     t.select_columns(names)
#     t.order_by(name, ascending=True)
#     t.head(n=10)
#     t.tail(n=10)
#
#   Aggregations (return number):
#     t.sum(name)
#     t.mean(name)
#     t.min(name)
#     t.max(name)
#     t.count()                       row count (alias for length)
#
#   Charts (return Image-compatible objects that auto-display):
#     t.bar_chart(x_name, y_name, title=None)
#     t.scatter_chart(x_name, y_name, title=None)
#     t.line_chart(x_name, y_name, title=None)
#     t.histogram(name, bins=10, title=None)
#
#   Escape hatch:
#     t.to_pandas()                   -> pandas.DataFrame (lazy import)

import math as _math


# -----------------------------------------------------------------------------
# Cell formatting (for HTML display)
# -----------------------------------------------------------------------------

def _format_cell(value):
    """Render a cell value to a short display string."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, float):
        if _math.isnan(value):
            return "NaN"
        if _math.isinf(value):
            return "+inf" if value > 0 else "-inf"
        if value == int(value) and abs(value) < 1e16:
            return "%d" % int(value)
        return "%g" % value
    if isinstance(value, int):
        return "%d" % value
    if isinstance(value, str):
        return value
    return repr(value)


# -----------------------------------------------------------------------------
# The Table class
# -----------------------------------------------------------------------------

class Table:
    __slots__ = ("_columns", "_data", "_length")

    def __init__(self, columns, rows):
        """Build a table from a list of column names and a list of rows.

        Each row is a list/tuple aligned with `columns`. Rows may also be
        dicts; missing keys default to None.
        """
        cols = list(columns)
        if len(cols) != len(set(cols)):
            raise ValueError("Duplicate column names: %r" % (cols,))

        data = {c: [] for c in cols}
        n = 0
        for row in rows:
            n += 1
            if isinstance(row, dict):
                for c in cols:
                    data[c].append(row.get(c))
            else:
                row_seq = list(row)
                if len(row_seq) != len(cols):
                    raise ValueError(
                        "Row %d has %d values but the table has %d columns"
                        % (n - 1, len(row_seq), len(cols))
                    )
                for c, v in zip(cols, row_seq):
                    data[c].append(v)

        self._columns = cols
        self._data = data
        self._length = n

    # ---- Internal constructor that skips validation ----

    @classmethod
    def _from_columns(cls, columns, data, length):
        t = cls.__new__(cls)
        t._columns = list(columns)
        t._data = {c: list(data[c]) for c in t._columns}
        t._length = length
        return t

    # ---- Inspection ----

    def columns(self):
        """Names of the table's columns."""
        return list(self._columns)

    def length(self):
        """Number of rows in the table."""
        return self._length

    def __len__(self):
        return self._length

    def column(self, name):
        """All values in `name` as a list."""
        self._require_column(name)
        return list(self._data[name])

    def row(self, index):
        """Row at `index` as a {column: value} dict."""
        if index < 0 or index >= self._length:
            raise IndexError(
                "row index %d out of range (table has %d rows)"
                % (index, self._length)
            )
        return {c: self._data[c][index] for c in self._columns}

    def rows(self):
        """All rows as a list of {column: value} dicts."""
        return [self.row(i) for i in range(self._length)]

    # ---- Functional ops ----

    def filter(self, predicate):
        """Keep rows where `predicate(row_dict)` is truthy."""
        if not callable(predicate):
            raise TypeError("filter expects a function, got %r" % (predicate,))
        keep = []
        for i in range(self._length):
            row = {c: self._data[c][i] for c in self._columns}
            if predicate(row):
                keep.append(i)
        new_data = {c: [self._data[c][i] for i in keep] for c in self._columns}
        return Table._from_columns(self._columns, new_data, len(keep))

    def transform_column(self, name, fn):
        """Replace `name` with the result of `fn(value)` applied to each value."""
        self._require_column(name)
        if not callable(fn):
            raise TypeError("transform_column expects a function, got %r" % (fn,))
        new_data = {c: list(self._data[c]) for c in self._columns}
        new_data[name] = [fn(v) for v in self._data[name]]
        return Table._from_columns(self._columns, new_data, self._length)

    def add_column(self, name, values_or_fn):
        """Add a new column.

        Pass a list of values aligned with the existing rows, or a function
        that takes a row dict and returns the value for that row.
        """
        if name in self._data:
            raise ValueError("Column %r already exists" % name)
        if callable(values_or_fn):
            new_values = []
            for i in range(self._length):
                row = {c: self._data[c][i] for c in self._columns}
                new_values.append(values_or_fn(row))
        else:
            new_values = list(values_or_fn)
            if len(new_values) != self._length:
                raise ValueError(
                    "Column %r has %d values, but the table has %d rows"
                    % (name, len(new_values), self._length)
                )
        new_columns = self._columns + [name]
        new_data = {c: list(self._data[c]) for c in self._columns}
        new_data[name] = new_values
        return Table._from_columns(new_columns, new_data, self._length)

    def select_columns(self, names):
        """Keep only the columns in `names`, in that order."""
        names = list(names)
        for n in names:
            self._require_column(n)
        new_data = {n: list(self._data[n]) for n in names}
        return Table._from_columns(names, new_data, self._length)

    def order_by(self, name, ascending=True):
        """Sort rows by `name` (ascending by default)."""
        self._require_column(name)
        # Sort indices to keep all columns in lockstep.
        order = sorted(
            range(self._length),
            key=lambda i: _sort_key(self._data[name][i]),
            reverse=not ascending,
        )
        new_data = {c: [self._data[c][i] for i in order] for c in self._columns}
        return Table._from_columns(self._columns, new_data, self._length)

    def head(self, n=10):
        """First `n` rows as a new table."""
        return self._slice(0, min(n, self._length))

    def tail(self, n=10):
        """Last `n` rows as a new table."""
        start = max(0, self._length - n)
        return self._slice(start, self._length)

    def _slice(self, start, end):
        new_data = {c: self._data[c][start:end] for c in self._columns}
        return Table._from_columns(self._columns, new_data, end - start)

    # ---- Aggregations ----

    def sum(self, name):
        """Sum of all values in `name` (numeric column)."""
        return _sum_numeric(self._numeric_column(name, "sum"))

    def mean(self, name):
        """Mean (average) of `name`."""
        values = self._numeric_column(name, "mean")
        if len(values) == 0:
            raise ValueError("mean of empty column %r" % name)
        return _sum_numeric(values) / len(values)

    def min(self, name):
        """Minimum value in `name`."""
        self._require_column(name)
        values = self._data[name]
        if len(values) == 0:
            raise ValueError("min of empty column %r" % name)
        return min(values, key=_sort_key)

    def max(self, name):
        """Maximum value in `name`."""
        self._require_column(name)
        values = self._data[name]
        if len(values) == 0:
            raise ValueError("max of empty column %r" % name)
        return max(values, key=_sort_key)

    def count(self):
        """Number of rows (alias for length)."""
        return self._length

    # ---- Charts ----

    def bar_chart(self, x, y, title=None):
        """Bar chart: one bar per row, x as label, y as height."""
        self._require_column(x)
        self._require_column(y)
        labels = [_format_cell(v) for v in self._data[x]]
        values = self._numeric_column(y, "bar_chart")
        return _BonnieChart(_render_bar_chart(labels, values, x, y, title))

    def scatter_chart(self, x, y, title=None):
        """Scatter plot of x vs y (both numeric)."""
        xs = self._numeric_column(x, "scatter_chart")
        ys = self._numeric_column(y, "scatter_chart")
        return _BonnieChart(_render_xy_chart(xs, ys, x, y, title, mode="scatter"))

    def line_chart(self, x, y, title=None):
        """Line chart of x vs y (both numeric, sorted by x)."""
        xs = self._numeric_column(x, "line_chart")
        ys = self._numeric_column(y, "line_chart")
        # Sort by x so the line draws monotonically.
        pairs = sorted(zip(xs, ys), key=lambda p: p[0])
        sx = [p[0] for p in pairs]
        sy = [p[1] for p in pairs]
        return _BonnieChart(_render_xy_chart(sx, sy, x, y, title, mode="line"))

    def histogram(self, name, bins=10, title=None):
        """Histogram of `name` (numeric)."""
        if bins < 1:
            raise ValueError("bins must be >= 1")
        values = self._numeric_column(name, "histogram")
        return _BonnieChart(_render_histogram(values, bins, name, title))

    # ---- Display protocol ----

    def _bonnie_table_data(self, max_rows=200):
        """Return the JSON-friendly payload the host renders."""
        n = self._length
        shown = min(n, max_rows)
        rows = []
        for i in range(shown):
            rows.append([_format_cell(self._data[c][i]) for c in self._columns])
        return {
            "type": "table",
            "columns": list(self._columns),
            "rows": rows,
            "row_count": n,
            "shown_count": shown,
            "truncated": n > shown,
        }

    # ---- Escape hatch ----

    def to_pandas(self):
        """Convert to a pandas DataFrame.

        Lazy import: pandas is only loaded if you actually call this.
        Inside Pyodide, this triggers a micropip install of pandas the
        first time you use it; subsequent calls reuse the loaded module.
        """
        import pandas as _pd  # noqa: F401  (raises ImportError if unavailable)
        return _pd.DataFrame({c: list(self._data[c]) for c in self._columns})

    # ---- Repr ----

    def __repr__(self):
        return "<Table %d rows x %d columns: %s>" % (
            self._length,
            len(self._columns),
            ", ".join(self._columns),
        )

    # ---- Helpers ----

    def _require_column(self, name):
        if name not in self._data:
            raise KeyError(
                "No column named %r (have: %s)" % (name, ", ".join(self._columns))
            )

    def _numeric_column(self, name, op):
        self._require_column(name)
        out = []
        for v in self._data[name]:
            f = _to_number(v)
            if f is None:
                raise TypeError(
                    "%s needs a numeric column; column %r contains %r"
                    % (op, name, v)
                )
            out.append(f)
        return out


# -----------------------------------------------------------------------------
# Constructors (module-level)
# -----------------------------------------------------------------------------

def table(columns, rows):
    """Build a table from a list of column names and a list of rows."""
    return Table(columns, rows)


def table_from_columns(data):
    """Build a table from a `{name: list-of-values}` dict.

    Iteration order of the dict determines column order (Python 3.7+
    preserves insertion order).
    """
    cols = list(data.keys())
    n = None
    for c in cols:
        ln = len(data[c])
        if n is None:
            n = ln
        elif ln != n:
            raise ValueError(
                "Columns have differing lengths: %r"
                % {c: len(data[c]) for c in cols}
            )
    if n is None:
        n = 0
    return Table._from_columns(cols, data, n)


# -----------------------------------------------------------------------------
# Numeric helpers
# -----------------------------------------------------------------------------

def _to_number(value):
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (_math.isnan(value) or _math.isinf(value)):
            return None
        return float(value)
    return None


def _sum_numeric(values):
    s = 0.0
    for v in values:
        s += v
    return s


def _sort_key(value):
    """Sort key tolerant of mixed None/str/numeric columns."""
    if value is None:
        return (0, 0)
    if isinstance(value, bool):
        return (1, int(value))
    if isinstance(value, (int, float)):
        return (1, float(value))
    if isinstance(value, str):
        return (2, value)
    return (3, repr(value))


# -----------------------------------------------------------------------------
# Chart rendering
# -----------------------------------------------------------------------------
#
# Charts are pure SVG, produced as a `_BonnieChart` object that exposes the
# image-display protocol so the host's existing image-card pipeline can
# render them. We don't subclass `Image` from bonnieImageLib so the table
# library doesn't need to import it; we duck-type via `_bonnie_image_data`.

_CHART_W = 480
_CHART_H = 320
_CHART_MARGIN_L = 56
_CHART_MARGIN_R = 16
_CHART_MARGIN_T = 28  # space for title
_CHART_MARGIN_B = 44


def _xml_escape(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


class _BonnieChart:
    """An immutable, displayable SVG chart. Duck-types as a Bonnie image."""

    def __init__(self, svg_payload):
        # svg_payload: {"width", "height", "data"}
        self._payload = svg_payload

    def _bonnie_image_data(self):
        return {
            "type": "svg",
            "width": int(self._payload["width"]),
            "height": int(self._payload["height"]),
            "data": self._payload["data"],
        }

    def __repr__(self):
        return "<Chart %dx%d>" % (self._payload["width"], self._payload["height"])


def _plot_box():
    """Inner plotting rectangle: (x, y, w, h)."""
    x = _CHART_MARGIN_L
    y = _CHART_MARGIN_T
    w = _CHART_W - _CHART_MARGIN_L - _CHART_MARGIN_R
    h = _CHART_H - _CHART_MARGIN_T - _CHART_MARGIN_B
    return x, y, w, h


def _nice_step(span, target_ticks):
    """Pick a 1/2/5*10^k step that gives roughly `target_ticks` ticks."""
    if span <= 0:
        return 1.0
    raw = span / max(1, target_ticks)
    mag = 10.0 ** _math.floor(_math.log10(raw))
    norm = raw / mag
    if norm < 1.5:
        nice = 1.0
    elif norm < 3.5:
        nice = 2.0
    elif norm < 7.5:
        nice = 5.0
    else:
        nice = 10.0
    return nice * mag


def _nice_ticks(lo, hi, target=5):
    if lo == hi:
        # Pad a degenerate range so we still draw something sensible.
        if lo == 0:
            lo, hi = -1.0, 1.0
        else:
            lo, hi = lo - abs(lo) * 0.5, hi + abs(hi) * 0.5
    step = _nice_step(hi - lo, target)
    start = _math.floor(lo / step) * step
    end = _math.ceil(hi / step) * step
    ticks = []
    v = start
    # Guard against floating-point drift on the upper bound.
    while v <= end + step * 0.5:
        ticks.append(v)
        v += step
    return ticks, start, end


def _format_tick(v):
    if v == int(v) and abs(v) < 1e16:
        return "%d" % int(v)
    return "%g" % v


def _chart_frame(title, x_label, y_label, body_svg):
    """Wrap chart body SVG with title + axis labels + outer <svg>."""
    px, py, pw, ph = _plot_box()
    title_svg = ""
    if title:
        title_svg = (
            '<text x="%d" y="%d" text-anchor="middle" '
            'font-size="13" font-weight="600">%s</text>'
        ) % (_CHART_W / 2, _CHART_MARGIN_T - 12, _xml_escape(title))

    x_label_svg = (
        '<text x="%d" y="%d" text-anchor="middle" '
        'font-size="11" font-style="italic">%s</text>'
    ) % (px + pw / 2, _CHART_H - 8, _xml_escape(x_label))

    # y-label rotated 90deg, anchored on the left margin
    y_label_svg = (
        '<text x="%d" y="%d" text-anchor="middle" font-size="11" '
        'font-style="italic" transform="rotate(-90 %d %d)">%s</text>'
    ) % (16, py + ph / 2, 16, py + ph / 2, _xml_escape(y_label))

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
        'viewBox="0 0 %d %d" font-family="sans-serif" '
        'shape-rendering="geometricPrecision">'
        '<rect x="0" y="0" width="%d" height="%d" fill="white"/>'
        "%s%s%s%s</svg>"
    ) % (
        _CHART_W,
        _CHART_H,
        _CHART_W,
        _CHART_H,
        _CHART_W,
        _CHART_H,
        title_svg,
        x_label_svg,
        y_label_svg,
        body_svg,
    )


def _draw_y_axis(lo, hi, ticks):
    px, py, pw, ph = _plot_box()
    parts = ['<g stroke="#bbb" stroke-width="1" fill="none">']
    text_parts = []
    for t in ticks:
        if t < lo - 1e-9 or t > hi + 1e-9:
            continue
        y = py + ph - (t - lo) / (hi - lo) * ph if hi > lo else py + ph / 2
        parts.append(
            '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#eee"/>'
            % (px, y, px + pw, y)
        )
        text_parts.append(
            '<text x="%g" y="%g" font-size="10" text-anchor="end" '
            'fill="#444" dominant-baseline="middle">%s</text>'
            % (px - 6, y, _xml_escape(_format_tick(t)))
        )
    # Axis line.
    parts.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#888"/>' % (px, py, px, py + ph))
    parts.append("</g>")
    return "".join(parts) + "".join(text_parts)


def _draw_x_axis_numeric(lo, hi, ticks):
    px, py, pw, ph = _plot_box()
    parts = ['<g stroke="#bbb" stroke-width="1" fill="none">']
    text_parts = []
    for t in ticks:
        if t < lo - 1e-9 or t > hi + 1e-9:
            continue
        x = px + (t - lo) / (hi - lo) * pw if hi > lo else px + pw / 2
        parts.append(
            '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#eee"/>'
            % (x, py, x, py + ph)
        )
        text_parts.append(
            '<text x="%g" y="%g" font-size="10" text-anchor="middle" fill="#444">%s</text>'
            % (x, py + ph + 14, _xml_escape(_format_tick(t)))
        )
    parts.append(
        '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#888"/>'
        % (px, py + ph, px + pw, py + ph)
    )
    parts.append("</g>")
    return "".join(parts) + "".join(text_parts)


def _draw_x_axis_categorical(labels):
    px, py, pw, ph = _plot_box()
    parts = ['<g stroke="#888" fill="none">']
    text_parts = []
    n = len(labels)
    if n > 0:
        slot = pw / n
        for i, label in enumerate(labels):
            cx = px + slot * (i + 0.5)
            text_parts.append(
                '<text x="%g" y="%g" font-size="10" text-anchor="middle" '
                'fill="#444">%s</text>' % (cx, py + ph + 14, _xml_escape(label))
            )
    parts.append(
        '<line x1="%g" y1="%g" x2="%g" y2="%g"/>'
        % (px, py + ph, px + pw, py + ph)
    )
    parts.append("</g>")
    return "".join(parts) + "".join(text_parts)


def _render_bar_chart(labels, values, x_label, y_label, title):
    px, py, pw, ph = _plot_box()
    n = len(values)
    lo = min(0.0, min(values) if values else 0.0)
    hi = max(values) if values else 1.0
    if hi == lo:
        hi = lo + 1.0
    ticks, lo_n, hi_n = _nice_ticks(lo, hi, target=5)

    body = []
    body.append(_draw_y_axis(lo_n, hi_n, ticks))
    body.append(_draw_x_axis_categorical(labels))

    if n > 0:
        slot = pw / n
        bar_w = slot * 0.7
        for i, v in enumerate(values):
            cx = px + slot * (i + 0.5)
            bx = cx - bar_w / 2
            y0 = py + ph - (0 - lo_n) / (hi_n - lo_n) * ph
            yv = py + ph - (v - lo_n) / (hi_n - lo_n) * ph
            top = min(y0, yv)
            h = abs(y0 - yv)
            body.append(
                '<rect x="%g" y="%g" width="%g" height="%g" fill="#4f8cff" />'
                % (bx, top, bar_w, h)
            )
    return {
        "width": _CHART_W,
        "height": _CHART_H,
        "data": _chart_frame(title, x_label, y_label, "".join(body)),
    }


def _render_xy_chart(xs, ys, x_label, y_label, title, mode):
    px, py, pw, ph = _plot_box()
    if not xs:
        body = ""
        return {
            "width": _CHART_W,
            "height": _CHART_H,
            "data": _chart_frame(title, x_label, y_label, body),
        }

    x_lo, x_hi = min(xs), max(xs)
    y_lo, y_hi = min(ys), max(ys)
    x_ticks, x_lo_n, x_hi_n = _nice_ticks(x_lo, x_hi, target=6)
    y_ticks, y_lo_n, y_hi_n = _nice_ticks(y_lo, y_hi, target=5)

    def to_px(x, y):
        sx = px + (x - x_lo_n) / (x_hi_n - x_lo_n) * pw if x_hi_n > x_lo_n else px + pw / 2
        sy = py + ph - (y - y_lo_n) / (y_hi_n - y_lo_n) * ph if y_hi_n > y_lo_n else py + ph / 2
        return sx, sy

    body = []
    body.append(_draw_y_axis(y_lo_n, y_hi_n, y_ticks))
    body.append(_draw_x_axis_numeric(x_lo_n, x_hi_n, x_ticks))

    if mode == "line":
        coords = [to_px(x, y) for x, y in zip(xs, ys)]
        path = "M " + " L ".join("%g %g" % (sx, sy) for sx, sy in coords)
        body.append(
            '<path d="%s" fill="none" stroke="#4f8cff" stroke-width="2" '
            'stroke-linejoin="round" stroke-linecap="round"/>' % path
        )
        for sx, sy in coords:
            body.append(
                '<circle cx="%g" cy="%g" r="2.5" fill="#4f8cff"/>' % (sx, sy)
            )
    else:
        for x, y in zip(xs, ys):
            sx, sy = to_px(x, y)
            body.append(
                '<circle cx="%g" cy="%g" r="3" fill="#4f8cff" opacity="0.7"/>'
                % (sx, sy)
            )
    return {
        "width": _CHART_W,
        "height": _CHART_H,
        "data": _chart_frame(title, x_label, y_label, "".join(body)),
    }


def _render_histogram(values, bins, name, title):
    px, py, pw, ph = _plot_box()
    if not values:
        body = ""
        return {
            "width": _CHART_W,
            "height": _CHART_H,
            "data": _chart_frame(title, name, "count", body),
        }

    lo, hi = min(values), max(values)
    if hi == lo:
        hi = lo + 1.0  # avoid zero-width bins for constant data
    width = (hi - lo) / bins
    counts = [0] * bins
    for v in values:
        idx = int((v - lo) / width)
        if idx == bins:
            idx = bins - 1
        counts[idx] += 1
    max_count = max(counts) if counts else 1

    y_ticks, y_lo_n, y_hi_n = _nice_ticks(0, max_count, target=5)
    x_ticks, x_lo_n, x_hi_n = _nice_ticks(lo, hi, target=6)

    body = []
    body.append(_draw_y_axis(y_lo_n, y_hi_n, y_ticks))
    body.append(_draw_x_axis_numeric(x_lo_n, x_hi_n, x_ticks))

    for i, c in enumerate(counts):
        bin_lo = lo + i * width
        bin_hi = bin_lo + width
        sx_lo = px + (bin_lo - x_lo_n) / (x_hi_n - x_lo_n) * pw
        sx_hi = px + (bin_hi - x_lo_n) / (x_hi_n - x_lo_n) * pw
        # Inset slightly so bars don't touch.
        bar_w = max(1.0, sx_hi - sx_lo - 1)
        y_top = py + ph - (c - y_lo_n) / (y_hi_n - y_lo_n) * ph if y_hi_n > y_lo_n else py + ph
        h = py + ph - y_top
        body.append(
            '<rect x="%g" y="%g" width="%g" height="%g" '
            'fill="#4f8cff" opacity="0.85"/>' % (sx_lo + 0.5, y_top, bar_w, h)
        )
    return {
        "width": _CHART_W,
        "height": _CHART_H,
        "data": _chart_frame(title, name, "count", "".join(body)),
    }


# -----------------------------------------------------------------------------
# Names exported into user globals by the bootstrap.
# -----------------------------------------------------------------------------

BONNIE_TABLE_EXPORTS = [
    "Table",
    "table",
    "table_from_columns",
]
