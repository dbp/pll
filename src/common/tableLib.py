# PLL table library.
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
#     load_table(source)              read a CSV, from a path or a URL.
#                                     Every cell is text, as in Pyret;
#                                     convert with transform_column.
#     t.add_row(row)                  one more row at the end
#
#   Inspection:
#     t.columns()                     -> list[str]
#     t.length() / len(t)             -> int
#     t.column(name)                  -> list of values
#     t.row(index)                    -> Row, a dict
#     t.rows()                        -> list[Row]
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
#   Charts (return images, which display and combine like any other). The
#   set matches what the Pyret charting library gives a course, so an
#   assignment written against one can be run against the other:
#     t.bar_chart(x_name, y_name)             one bar per row
#     t.freq_bar_chart(name)                  one bar per distinct value
#     t.pie_chart(label_name, value_name)
#     t.scatter_chart(x, y) / t.scatter_plot(x, y)
#     t.labeled_scatter_plot(label_name, x, y)
#     t.line_chart(x, y)
#     t.dot_plot(name) / t.labeled_dot_plot(label_name, name)
#     t.box_plot(name)                        quartiles, whiskers, outliers
#     t.histogram(name, bins=10, bin_width=None)
#     t.lr_plot(x, y) / t.labeled_lr_plot(label_name, x, y)
#     function_plot(f, x_min, x_max)          module-level; needs no table
#   All take an optional `title=`.
#
#   Statistics behind the charts:
#     t.linear_regression(x, y)       -> (slope, intercept, r_squared)
#   Anything else - median, stdev, modes - is Python's `statistics`.
#
#   Equality:
#     t1 == t2                        same columns in the same order, same
#                                     values. `repr` shows the rows, since
#                                     that is what a failed test prints.
#
#   Escape hatch:
#     t.to_pandas()                   -> pandas.DataFrame (lazy import)

import csv as _csv
import io as _io
import math as _math
import numbers as _pll_tbl_numbers
import sys as _pll_tbl_sys

#: Rows `repr(table)` shows before truncating, few enough not to bury the
#: rest of a message. A failed `==` between tables says where they differ
#: (`_pll_compare_tables`), so the rows that matter are always shown.
_REPR_ROWS = 6

#: The most of a table's text the panel is given for Save CSV.
_PLL_CSV_LIMIT = 8 * 1024 * 1024


# -----------------------------------------------------------------------------
# Cell formatting (for HTML display)
# -----------------------------------------------------------------------------

def _format_cell(value):
    """A cell as the panel and the command line show it: as Python prints it.

    A float is its `repr`, every digit of it - `12999.99`, not a rounded
    `13000` - so what is shown is what a test compares. A missing value
    (None) is blank.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, float):
        return repr(float(value))
    return str(value) if isinstance(value, _pll_tbl_numbers.Number) else repr(value)


def _pll_is_number(value):
    """A number to count with: an int or a float, numpy's too, not a bool."""
    return isinstance(value, _pll_tbl_numbers.Real) and not isinstance(value, bool)


def _pll_student_level():
    """The level of the student's code that called into the library.

    Read from the namespace of the nearest of their frames, as the
    strict-number check reads it, so a helper module at another level
    gets its own.
    """
    frame = _pll_tbl_sys._getframe(1)
    while frame is not None:
        if _pll_is_students(frame.f_code.co_filename):
            return frame.f_globals.get("__pll_level__", _PLL_LEVEL_RAW)
        frame = frame.f_back
    return _PLL_LEVEL_RAW


# -----------------------------------------------------------------------------
# Naming things in messages
# -----------------------------------------------------------------------------

def _pll_literal(value, limit=60):
    """A value written the way it would be written in a program.

    `["Feb"]`, not `['Feb']`: a student reads the message next to their own
    source, and showing them something they did not type makes them look
    for a difference that is not there.
    """
    if isinstance(value, str):
        text = '"%s"' % value
    elif isinstance(value, (list, tuple)):
        text = "[%s]" % ", ".join(_pll_literal(v, limit) for v in value)
    elif value is None or isinstance(value, bool):
        text = repr(value)
    elif isinstance(value, (int, float)):
        text = _format_cell(value)
    else:
        text = repr(value)
    if len(text) > limit:
        return text[: limit - 4] + " ...]" if text.startswith("[") else text[: limit - 3] + "..."
    return text


def _pll_closest(name, candidates):
    """The candidate `name` was probably meant to be, and why.

    Returns `(candidate, note)`, where the note explains a match that
    differs only in case - which is the commonest of these and the one a
    student is least likely to spot by reading.
    """
    if not isinstance(name, str):
        return (None, "")
    candidates = [c for c in candidates if isinstance(c, str)]
    for candidate in candidates:
        if candidate.lower() == name.lower():
            return (candidate, " Column names are case-sensitive.")
    # Only one column starting with what was written: `hours` for
    # `hours-worked`, `drinks` for `drinks-sold`. Too far for a spelling
    # match, and still almost certainly what was meant.
    starting = [c for c in candidates if c.lower().startswith(name.lower()) and name]
    if len(starting) == 1:
        return (starting[0], "")
    return (_pll_closest_name(name, candidates), "")


def _pll_q(name):
    """A column name written as a student writes it: `"month"`.

    `%r` gives `'month'`, which is not what they typed; a message that
    quotes their code differently from how they wrote it sends them looking
    for a difference that is not there.
    """
    return _pll_literal(name) if isinstance(name, str) else repr(name)


def _pll_no_column(name, columns, what="the table"):
    """The one wording for a column that is not there."""
    suggestion, note = _pll_closest(name, columns)
    return "%s has no column %s (it has: %s).%s%s" % (
        what,
        _pll_q(name),
        ", ".join(columns),
        " Did you mean %s?" % _pll_q(suggestion) if suggestion is not None else "",
        note,
    )


def _pll_function_name(fn):
    """`` `below_1k` `` for a message about a function the student passed."""
    name = getattr(fn, "__name__", None)
    return "`%s`" % name if name and name != "<lambda>" else "the function given"


def _pll_check_function(fn, who, takes):
    """A function argument, checked before it is used.

    Two mistakes hide here. Passing the *result* of a call rather than the
    function - `transform_column("servings", int())` - and passing a
    function that takes the wrong number of things, which fails inside the
    library with a message pointing at the `def` rather than at the call.
    """
    if not callable(fn):
        raise TypeError(
            "%s needs a function, but got %s. %s calls your function with "
            "%s at a time, so give it the function's name with no brackets "
            "after it - `int`, not `int()`." % (who, _pll_describe(fn), who, takes)
        )
    count = _pll_parameter_count(fn)
    if count is None or count == 1:
        return fn
    named = _pll_function_name(fn)
    if count == 0:
        raise TypeError(
            "%s calls %s with %s, but %s takes no parameters."
            % (who, named, takes, named)
        )
    raise TypeError(
        "%s calls %s with %s, but %s takes %d parameters."
        % (who, named, takes, named, count)
    )


def _pll_parameter_count(fn):
    """How many arguments `fn` must be called with, or None if unknowable.

    Read off the code object rather than with `inspect`, which is slower
    and would be imported only for this. Anything that is not a plain
    Python function - a builtin like `int`, a class, a partial - gives
    None, and is left to Python to check.
    """
    code = getattr(fn, "__code__", None)
    if code is None:
        return None
    if code.co_flags & 0x04:  # *args: takes any number
        return None
    required = code.co_argcount
    defaults = getattr(fn, "__defaults__", None)
    if defaults:
        required -= len(defaults)
    if getattr(fn, "__self__", None) is not None:
        required -= 1
    return required


def _pll_raised_in_students_code(exc):
    """Whether `exc` came from inside the student's own code."""
    tb = exc.__traceback__
    while tb is not None:
        if _pll_is_students(tb.tb_frame.f_code.co_filename):
            return True
        tb = tb.tb_next
    return False


def _pll_apply_to_cell(fn, value, index, name):
    """`fn(value)`, with the row and value named if a conversion fails.

    `transform_column("tickets", int)` on a column with one blank cell
    fails with "invalid literal for int() with base 10: ''", which says
    nothing about which row or which column. Only a conversion - `int`,
    `float`, a function that is not the student's - is reworded: an error
    in their own function is theirs, and goes on as it was raised, with
    its own line and name, to be explained like any other.
    """
    try:
        return fn(value)
    except Exception as exc:
        if (
            type(exc) not in (ValueError, TypeError)
            or type(exc).__name__ == "TypeCheckError"
            or _pll_raised_in_students_code(exc)
        ):
            raise
        # What to do about it, rather than Python's own words after a colon:
        # a blank cell needs a decision, which is a function of their own.
        fn_name = getattr(fn, "__name__", "the function")
        if value == "":
            advice = (
                "A blank cell cannot be converted; write a function that "
                "decides what a blank should become, and give that to "
                "transform_column instead."
            )
        else:
            advice = "%s cannot convert %s." % (
                "`%s`" % fn_name if fn_name != "the function" else "The function",
                _pll_literal(value),
            )
        raise type(exc)(
            "transform_column(%s, %s) failed on the %s row, whose value is %s. %s"
            % (
                _pll_q(name),
                fn_name,
                _pll_ordinal(index),
                'blank ("")' if value == "" else _pll_literal(value),
                advice,
            )
        ) from None


class Row(dict):
    """One row of a table: a dict that can explain itself.

    A plain dict answers `r["rider"]` with `KeyError: 'rider'` - a bare
    name, with nothing about the table it came from or the columns it does
    have - and `r.riders` with "'dict' object has no attribute 'riders'".
    Both now say what the table methods say.

    It stays a `dict` in every other way, so a row still compares equal to
    the plain dict a test is written with, and everything that works on a
    dict still works.
    """

    __slots__ = ()

    def __missing__(self, key):
        raise KeyError(_pll_no_column(key, list(self), "this row"))

    def __getattr__(self, name):
        # Dunder and private lookups are Python's own probing (`copy`,
        # `__deepcopy__`, Pyodide's conversion); they have to keep failing
        # the ordinary way or those mechanisms break.
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self:
            raise AttributeError(
                'to get a value out of a row, use square brackets: row["%s"]' % name
            )
        raise AttributeError(
            "%s Values come out of a row with square brackets, like row[%s]."
            % (
                _pll_no_column(name, list(self), "this row"),
                _pll_q(list(self)[0] if self else "column"),
            )
        )


# -----------------------------------------------------------------------------
# The Table class
# -----------------------------------------------------------------------------

class Table:
    """A table: named columns, and rows of values in them.

    Make one with `table(columns, rows)`, `table_from_columns(...)` or
    `load_table("file.csv")`. A table never changes: every method that
    changes something gives back a new table.
    """

    __slots__ = ("_columns", "_data", "_length")

    def __init__(self, columns, rows):
        """Build a table from a list of column names and a list of rows.

        Each row is a list/tuple aligned with `columns`. Rows may also be
        dicts; missing keys default to None.
        """
        # A single string is iterable, so `table("month, riders", ...)`
        # would come apart into letters and be reported as duplicate columns.
        if isinstance(columns, str):
            raise TypeError(
                "table's column names should be a list of strings, like "
                '["month", "riders"] - not one string.'
            )
        cols = list(columns)
        for c in cols:
            if not isinstance(c, str):
                raise TypeError(
                    "table's column names have to be strings, but one of them "
                    "is %s." % _pll_describe(c)
                )
        if len(cols) != len(set(cols)):
            repeated = sorted({c for c in cols if cols.count(c) > 1})
            raise ValueError(
                "table has two columns called %s. Column names have to be "
                "different, so give one of them another name."
                % ", ".join(_pll_q(c) for c in repeated)
            )

        if isinstance(rows, str):
            raise TypeError(
                "table's rows should be a list of rows, like "
                '[["Jan", 1], ["Feb", 2]] - not one string.'
            )
        data = {c: [] for c in cols}
        n = 0
        for row in rows:
            for c, v in zip(cols, _pll_row_values(row, cols, n, "table")):
                data[c].append(v)
            n += 1

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
        # Checked before the comparison below, which otherwise fails inside
        # `row` with "'<' not supported between instances of 'str' and
        # 'int'" - naming neither `row` nor the argument.
        if isinstance(index, float) and index.is_integer():
            raise TypeError(
                "row expects a whole row number, but got %r, which is a float: "
                "write row(%d)." % (index, int(index))
            )
        if not isinstance(index, _pll_tbl_numbers.Integral) or isinstance(index, bool):
            raise TypeError(
                "row expects a row number, but got %s. To find rows by a "
                "value, use filter." % _pll_describe(index)
            )
        index = int(index)
        if index < 0 or index >= self._length:
            raise IndexError(
                "there is no row %d: this table's rows are numbered 0 to %d."
                % (index, self._length - 1)
                if self._length > 0
                else "there is no row %d: this table has no rows." % index
            )
        return Row((c, self._data[c][index]) for c in self._columns)

    def rows(self):
        """All rows as a list of {column: value} dicts."""
        return [self.row(i) for i in range(self._length)]

    # ---- Functional ops ----

    def filter(self, predicate):
        """Keep rows where `predicate(row_dict)` is truthy."""
        _pll_check_function(predicate, "filter", "one row")
        keep = []
        for i in range(self._length):
            row = Row((c, self._data[c][i]) for c in self._columns)
            verdict = predicate(row)
            if not isinstance(verdict, bool):
                # A number is truthy, so a predicate that returns the value
                # it meant to compare would keep every row in silence.
                raise TypeError(
                    "the function given to filter has to return True or "
                    "False, but %s returned %s for the %s row. Did you mean "
                    "to compare it with something?"
                    % (
                        _pll_function_name(predicate),
                        _pll_describe(verdict),
                        _pll_ordinal(i),
                    )
                )
            if verdict:
                keep.append(i)
        new_data = {c: [self._data[c][i] for i in keep] for c in self._columns}
        return Table._from_columns(self._columns, new_data, len(keep))

    def transform_column(self, name, fn):
        """Replace `name` with the result of `fn(value)` applied to each value."""
        self._require_column(name)
        _pll_check_function(fn, "transform_column", "one value")
        new_data = {c: list(self._data[c]) for c in self._columns}
        new_data[name] = [
            _pll_apply_to_cell(fn, v, i, name) for i, v in enumerate(self._data[name])
        ]
        return Table._from_columns(self._columns, new_data, self._length)

    def add_column(self, name, values_or_fn):
        """Add a new column.

        Pass a list of values aligned with the existing rows, or a function
        that takes a row dict and returns the value for that row.
        """
        _pll_check_column_name(name, "add_column")
        if name in self._data:
            raise ValueError(
                "this table already has a column called %s. To change the "
                "values in it, use transform_column(%s, ...)."
                % (_pll_q(name), _pll_q(name))
            )
        if callable(values_or_fn):
            _pll_check_function(values_or_fn, "add_column", "one row")
            new_values = []
            for i in range(self._length):
                row = Row((c, self._data[c][i]) for c in self._columns)
                new_values.append(values_or_fn(row))
        else:
            if isinstance(values_or_fn, (str, dict)) or not hasattr(values_or_fn, "__iter__"):
                raise TypeError(
                    "add_column needs a list of values, one for each row, or a "
                    "function that works out the value from a row - but it was "
                    "given %s." % _pll_describe(values_or_fn)
                )
            new_values = list(values_or_fn)
            if len(new_values) != self._length:
                raise ValueError(
                    "add_column was given %d value%s for %s, but the table "
                    "has %d rows."
                    % (
                        len(new_values),
                        "" if len(new_values) == 1 else "s",
                        _pll_q(name),
                        self._length,
                    )
                )
        new_columns = self._columns + [name]
        new_data = {c: list(self._data[c]) for c in self._columns}
        new_data[name] = new_values
        return Table._from_columns(new_columns, new_data, self._length)

    def add_row(self, row):
        """This table with `row` added at the end.

        `row` is a list of values in the order of the columns, or a dict
        from column names to values, as in `table(...)`.
        """
        values = _pll_row_values(row, self._columns, self._length, "add_row")
        new_data = {c: self._data[c] + [v] for c, v in zip(self._columns, values)}
        t = Table.__new__(Table)
        t._columns = list(self._columns)
        t._data = new_data
        t._length = self._length + 1
        return t

    def select_columns(self, names):
        """Keep only the columns in `names`, in that order."""
        # One string is iterable, so `select_columns("name")` would come
        # apart into letters and complain about a column called 'n'.
        if isinstance(names, str):
            raise TypeError(
                "select_columns takes a list of column names, like [%s] - "
                "not one name on its own." % _pll_q(names)
            )
        names = list(names)
        for n in names:
            self._require_column(n)
        repeated = sorted({n for n in names if names.count(n) > 1})
        if repeated:
            raise ValueError(
                "select_columns was given %s more than once; a table cannot "
                "have two columns of one name." % ", ".join(_pll_q(n) for n in repeated)
            )
        new_data = {n: list(self._data[n]) for n in names}
        return Table._from_columns(names, new_data, self._length)

    def order_by(self, name, ascending=True):
        """Sort rows by `name` (ascending by default)."""
        self._require_column(name)
        # `ascending="False"` is a non-empty string, so it would sort
        # ascending without a word.
        if not isinstance(ascending, bool):
            raise TypeError(
                "order_by's ascending has to be True or False, but it is %s."
                % _pll_describe(ascending)
            )
        values = self._data[name]
        self._refuse_numbers_as_text(name, "order_by", "sorts")
        # Sort indices to keep all columns in lockstep.
        order = sorted(
            range(self._length),
            key=lambda i: _sort_key(values[i]),
            reverse=not ascending,
        )
        new_data = {c: [self._data[c][i] for i in order] for c in self._columns}
        return Table._from_columns(self._columns, new_data, self._length)

    def head(self, n=10):
        """First `n` rows as a new table."""
        n = _pll_row_count(n, "head")
        return self._slice(0, min(n, self._length))

    def tail(self, n=10):
        """Last `n` rows as a new table."""
        n = _pll_row_count(n, "tail")
        start = max(0, self._length - n)
        return self._slice(start, self._length)

    def _slice(self, start, end):
        new_data = {c: self._data[c][start:end] for c in self._columns}
        return Table._from_columns(self._columns, new_data, end - start)

    # ---- Aggregations ----

    def sum(self, name):
        """Sum of all values in `name` (numeric column)."""
        return sum(self._numeric_column(name, "sum", counting=True))

    def mean(self, name):
        """Mean (average) of `name`."""
        values = self._numeric_column(name, "mean", counting=True)
        if len(values) == 0:
            raise ValueError(self._empty("mean", "nothing to average"))
        return sum(values) / len(values)

    def min(self, name):
        """Minimum value in `name`."""
        self._require_column(name)
        if self._length == 0:
            raise ValueError(self._empty("min", "no smallest value"))
        self._refuse_numbers_as_text(name, "min", "compares")
        return min(self._data[name], key=_sort_key)

    def max(self, name):
        """Maximum value in `name`."""
        self._require_column(name)
        if self._length == 0:
            raise ValueError(self._empty("max", "no largest value"))
        self._refuse_numbers_as_text(name, "max", "compares")
        return max(self._data[name], key=_sort_key)

    def count(self):
        """Number of rows (alias for length)."""
        return self._length

    # ---- Charts ----

    def bar_chart(self, x, y, title=None):
        """Bar chart: one bar per row, x as label, y as height."""
        self._require_column(x)
        self._require_column(y)
        labels = [_format_cell(v) for v in self._data[x]]
        values = self._numeric_column(y, "bar_chart", swap_with=x)
        return _PllChart(_render_bar_chart(labels, values, x, y, title))

    def scatter_chart(self, x, y, title=None):
        """Scatter plot of x vs y (both numeric)."""
        return self._scatter(x, y, title, "scatter_chart")

    def _scatter(self, x, y, title, who):
        xs = self._numeric_column(x, who)
        ys = self._numeric_column(y, who)
        return _PllChart(_render_xy_chart(xs, ys, x, y, title, mode="scatter"))

    def line_chart(self, x, y, title=None):
        """Line chart of x vs y (both numeric, sorted by x)."""
        xs = self._numeric_column(x, "line_chart")
        ys = self._numeric_column(y, "line_chart")
        # Sort by x so the line draws monotonically.
        pairs = sorted(zip(xs, ys), key=lambda p: p[0])
        sx = [p[0] for p in pairs]
        sy = [p[1] for p in pairs]
        return _PllChart(_render_xy_chart(sx, sy, x, y, title, mode="line"))

    def histogram(self, name, bins=10, bin_width=None, title=None):
        """Histogram of `name` (numeric).

        `bins` counts the buckets; `bin_width` sets how wide each one is
        instead, which is how the same chart is asked for in Pyret and is
        usually what the data calls for ("group ages by 5"): the buckets
        then start at a multiple of the width.
        """
        values = self._numeric_column(name, "histogram")
        if bin_width is not None:
            if not _pll_is_number(bin_width) or not _math.isfinite(bin_width):
                raise TypeError(
                    "histogram's `bin_width` has to be a number, but it is %s."
                    % _pll_describe(bin_width)
                )
            if bin_width <= 0:
                raise ValueError(
                    "histogram's `bin_width` has to be more than 0, but it is %s."
                    % _pll_number(bin_width)
                )
            if values and (max(values) - min(values)) / bin_width > 1000:
                raise ValueError(
                    "histogram's `bin_width` of %s would make more than 1000 bars "
                    "across these values; use a wider one."
                    % _pll_number(bin_width)
                )
            return _PllChart(_render_histogram(values, None, name, title, bin_width))
        if isinstance(bins, bool) or not isinstance(bins, _pll_tbl_numbers.Integral):
            raise TypeError(
                "histogram's `bins` has to be a whole number - it is how many bars "
                "to draw - but it is %s." % _pll_describe(bins)
            )
        if bins < 1:
            raise ValueError(
                "histogram's `bins` has to be 1 or more - it is how many bars "
                "to draw - but it is %s." % _pll_number(bins)
            )
        return _PllChart(_render_histogram(values, int(bins), name, title))

    # ---- Charts: the rest of the Pyret set ----

    def scatter_plot(self, x, y, title=None):
        """Scatter plot of x vs y. Another name for `scatter_chart`."""
        return self._scatter(x, y, title, "scatter_plot")

    def labeled_scatter_plot(self, labels, x, y, title=None):
        """Scatter plot with the points coloured and keyed by `labels`."""
        self._require_column(labels)
        xs = self._numeric_column(x, "labeled_scatter_plot")
        ys = self._numeric_column(y, "labeled_scatter_plot")
        names = [_format_cell(v) for v in self._data[labels]]
        return _PllChart(
            _render_xy_chart(xs, ys, x, y, title, mode="scatter", labels=names)
        )

    def pie_chart(self, labels, values, title=None):
        """Pie chart: one slice per row, sized by `values`."""
        self._require_column(labels)
        amounts = self._numeric_column(values, "pie_chart")
        for index, amount in enumerate(amounts):
            if amount < 0:
                raise ValueError(
                    "a pie chart cannot show a negative value, but column %s "
                    "holds %s in the %s row."
                    % (_pll_q(values), _pll_number(amount), _pll_ordinal(index))
                )
        names = [_format_cell(v) for v in self._data[labels]]
        return _PllChart(_render_pie_chart(names, amounts, title, values))

    def dot_plot(self, name, title=None):
        """One dot per row along `name`, stacked where rows share a value."""
        values = self._numeric_column(name, "dot_plot")
        if not values:
            raise ValueError(self._empty("dot_plot", "nothing to plot"))
        return _PllChart(_render_dot_plot(values, None, name, title))

    def labeled_dot_plot(self, labels, name, title=None):
        """`dot_plot`, with the dots coloured and keyed by `labels`."""
        self._require_column(labels)
        values = self._numeric_column(name, "labeled_dot_plot")
        if not values:
            raise ValueError(self._empty("labeled_dot_plot", "nothing to plot"))
        names = [_format_cell(v) for v in self._data[labels]]
        return _PllChart(_render_dot_plot(values, names, name, title))

    def freq_bar_chart(self, name, title=None):
        """How often each distinct value of `name` appears.

        Unlike `bar_chart` this needs one column, not two: it counts the
        rows itself. The column can hold anything - counting words is the
        usual reason to reach for it. The bars are in the values' order:
        numbers by size, words alphabetically.
        """
        self._require_column(name)
        counts = {}
        for value in self._data[name]:
            key = _format_cell(value)
            if key not in counts:
                counts[key] = [value, 0]
            counts[key][1] += 1
        if not counts:
            raise ValueError(self._empty("freq_bar_chart", "nothing to count"))
        keys = sorted(counts, key=lambda k: _sort_key(counts[k][0]))
        return _PllChart(
            _render_bar_chart(keys, [float(counts[k][1]) for k in keys], name, "count", title)
        )

    def box_plot(self, name, title=None):
        """Box and whisker plot of `name`: quartiles, range and outliers."""
        values = self._numeric_column(name, "box_plot")
        if not values:
            raise ValueError(self._empty("box_plot", "nothing to plot"))
        return _PllChart(_render_box_plot(values, name, title))

    def lr_plot(self, x, y, title=None):
        """Scatter plot with the line of best fit, and r-squared in the title."""
        xs = self._numeric_column(x, "lr_plot")
        ys = self._numeric_column(y, "lr_plot")
        slope, intercept, r_squared = _pll_linear_fit(xs, ys)
        line = ([min(xs), max(xs)], [slope * min(xs) + intercept, slope * max(xs) + intercept])
        return _PllChart(
            _render_xy_chart(
                xs, ys, x, y,
                title if title is not None else _fit_title(slope, intercept, r_squared),
                mode="scatter", lines=[line],
            )
        )

    def labeled_lr_plot(self, labels, x, y, title=None):
        """`lr_plot`, with the points coloured and keyed by `labels`."""
        self._require_column(labels)
        xs = self._numeric_column(x, "labeled_lr_plot")
        ys = self._numeric_column(y, "labeled_lr_plot")
        slope, intercept, r_squared = _pll_linear_fit(xs, ys)
        line = ([min(xs), max(xs)], [slope * min(xs) + intercept, slope * max(xs) + intercept])
        names = [_format_cell(v) for v in self._data[labels]]
        return _PllChart(
            _render_xy_chart(
                xs, ys, x, y,
                title if title is not None else _fit_title(slope, intercept, r_squared),
                mode="scatter", labels=names, lines=[line],
            )
        )

    def linear_regression(self, x, y):
        """(slope, intercept, r_squared) for `y` against `x`.

        The numbers behind `lr_plot`, for when you want to talk about the
        fit rather than look at it.
        """
        xs = self._numeric_column(x, "linear_regression")
        ys = self._numeric_column(y, "linear_regression")
        return _pll_linear_fit(xs, ys)

    # ---- Display protocol ----

    def _pll_table_data(self, max_rows=200):
        """Return the JSON-friendly payload the host renders.

        `rows` are the cells shown, as text; `numeric` says which columns
        hold only numbers, which the panel lines up on the right - so text
        that looks like a number, from a CSV, is left-aligned and can be
        seen not to be one. `csv` is the whole table for Save CSV, every
        row and every digit, as far as `_PLL_CSV_LIMIT`.
        """
        n = self._length
        shown = min(n, max_rows)
        rows = []
        for i in range(shown):
            rows.append([_format_cell(self._data[c][i]) for c in self._columns])
        numeric = []
        for c in self._columns:
            cells = [v for v in self._data[c][:shown] if v is not None]
            numeric.append(bool(cells) and all(_pll_is_number(v) for v in cells))
        csv_text, csv_rows = self._csv_text(_PLL_CSV_LIMIT)
        return {
            "type": "table",
            "columns": list(self._columns),
            "rows": rows,
            "row_count": n,
            "shown_count": shown,
            "truncated": n > shown,
            "numeric": numeric,
            "csv": csv_text,
            "csv_rows": csv_rows,
        }

    def _csv_text(self, limit):
        """The table as CSV, and how many rows that is: all that fit in `limit`."""
        out = _io.StringIO()
        writer = _csv.writer(out, lineterminator="\n")
        writer.writerow(self._columns)
        written = 0
        for i in range(self._length):
            writer.writerow([_format_cell(self._data[c][i]) for c in self._columns])
            if out.tell() > limit:
                break
            written += 1
        text = out.getvalue()
        if written < self._length:
            # The row that went past the limit is not kept.
            text = text[: text.rstrip("\n").rfind("\n") + 1]
        return text, written

    # ---- Escape hatch ----

    def to_pandas(self):
        """Convert to a pandas DataFrame.

        Lazy import: pandas is only loaded if you actually call this.
        Inside Pyodide, this triggers a micropip install of pandas the
        first time you use it; subsequent calls reuse the loaded module.
        """
        import pandas as _pd  # noqa: F401  (raises ImportError if unavailable)
        return _pd.DataFrame({c: list(self._data[c]) for c in self._columns})

    # ---- Equality ----

    def __eq__(self, other):
        """Same columns, in the same order, holding the same values.

        Column order counts: two tables that display differently are not
        the same table. Cells compare as Python values, so `1 == 1.0` - but
        a CSV's cells are text, and its "29" is not the number 29 until the
        column is converted.
        """
        if not isinstance(other, Table):
            return NotImplemented
        if self._columns != other._columns or self._length != other._length:
            return False
        return all(self._data[c] == other._data[c] for c in self._columns)

    # Defining `__eq__` makes a class unhashable unless it says otherwise,
    # and that is the right default here: a table's cells can be lists or
    # other unhashable values, so there is no honest hash to give.
    __hash__ = None

    # ---- Used the way a list or a dict is ----

    def __getitem__(self, key):
        if isinstance(key, str):
            raise TypeError(
                "a table's columns are not taken out with square brackets: "
                "write t.column(%s) for the values in it." % _pll_q(key)
            )
        if isinstance(key, _pll_tbl_numbers.Integral) and not isinstance(key, bool):
            raise TypeError(
                "a table's rows are not taken out with square brackets: "
                "write t.row(%d) for that row." % key
            )
        raise TypeError(
            "a table is not taken apart with square brackets: t.row(0) is a "
            'row, t.column("name") a column, and t.rows() every row.'
        )

    def __iter__(self):
        raise TypeError(
            "a table is not a list of rows itself: loop over t.rows(), as in "
            "`for r in t.rows():`."
        )

    def __getattr__(self, name):
        # Only for names the class does not have. Private and special
        # lookups are Python's own probing, and fail the ordinary way.
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._data:
            # `name=None`, so Python adds no "Did you mean" of its own: the
            # column is the answer, not a method spelt like it.
            raise AttributeError(
                "a table's columns are not attributes: write t.column(%s) for "
                "the values in it." % _pll_q(name),
                name=None,
                obj=None,
            )
        # Python adds the nearest method, after a full stop of its own.
        raise AttributeError("a table has no method `%s`" % name)

    # ---- Repr ----

    def __repr__(self):
        """A readable rendering, because this is what a failed test prints.

        The rows, not a summary like `<Table 3 rows x 2 columns: name, mpg>`,
        which is the same for any two tables of the same shape - exactly the
        case `assert t == expected` fails in. Rows are truncated so a big
        table cannot flood a message.
        """
        head = ", ".join(repr(c) for c in self._columns)
        shown = min(self._length, _REPR_ROWS)
        rows = []
        for i in range(shown):
            rows.append("[" + ", ".join(repr(self._data[c][i]) for c in self._columns) + "]")
        body = ", ".join(rows)
        if self._length > shown:
            body += ", ... (%d more rows)" % (self._length - shown)
        return "table([%s], [%s])" % (head, body)

    # ---- Helpers ----

    def _require_column(self, name):
        if not isinstance(name, str):
            raise TypeError(
                "a column is named by a string, like %s, but this is %s.%s"
                % (
                    _pll_q(self._columns[0]) if self._columns else '"name"',
                    _pll_describe(name),
                    " To keep several columns, use select_columns."
                    if isinstance(name, (list, tuple))
                    else "",
                )
            )
        if name not in self._data:
            raise KeyError(_pll_no_column(name, self._columns))

    def _empty(self, op, what):
        return "%s needs at least one row, but the table has none, so there is %s." % (op, what)

    def _refuse_numbers_as_text(self, name, op, does):
        """Stop `op` giving a wrong answer for numbers a CSV left as text.

        Text compares letter by letter, so "9" comes after "100". When every
        value in the column is a number written as text, and comparing them
        as text gives a different answer than as numbers would, the
        column was almost certainly never converted.
        """
        values = self._data[name]
        texts = [v for v in values if isinstance(v, str) and v.strip() != ""]
        if not texts or len(texts) != sum(1 for v in values if v is not None and v != ""):
            return
        try:
            numbers = [float(v) for v in texts]
        except ValueError:
            return
        if sorted(range(len(texts)), key=lambda i: texts[i]) == sorted(
            range(len(texts)), key=lambda i: (numbers[i], texts[i])
        ):
            return
        whole = all(n.is_integer() for n in numbers)
        first, second = sorted(texts, key=lambda t: float(t))[0], sorted(texts)[0]
        raise TypeError(
            "%s %s column %s as text, and as text %s comes before %s: the values "
            "were read from a CSV and never converted to numbers. Convert the "
            "column first: transform_column(%s, %s)."
            % (
                op,
                does,
                _pll_q(name),
                _pll_q(second),
                _pll_q(first),
                _pll_q(name),
                "int" if whole else "float",
            )
        )

    def _numeric_column(self, name, op, swap_with=None, counting=False):
        """The column as numbers, or an error saying why it is not.

        `swap_with` is the other column of a two-column chart, so a chart
        given its arguments the wrong way round can say so. `counting` is
        for `sum` and `mean`, which keep each number as it is - whole
        numbers add up to a whole number - and refuse True and False at the
        teaching levels, where neither is a number.
        """
        self._require_column(name)
        strict = counting and _pll_student_level() in _PLL_TEACHING_LEVELS
        out = []
        for index, v in enumerate(self._data[name]):
            if isinstance(v, bool):
                if strict:
                    raise TypeError(
                        "%s needs a column of numbers, but column %s holds %s in the "
                        "%s row. True and False are not numbers; to count the rows "
                        "where it is True, filter on it and take the length."
                        % (op, _pll_q(name), v, _pll_ordinal(index))
                    )
                out.append(int(v) if counting else float(v))
                continue
            if _pll_is_number(v):
                if isinstance(v, float) and not _math.isfinite(v):
                    raise ValueError(
                        "%s needs numbers it can %s, but column %s holds %s in the %s "
                        "row. Leave such rows out first, with filter."
                        % (
                            op,
                            "add up" if counting else "draw",
                            _pll_q(name),
                            "nan (\"not a number\")" if v != v else repr(v),
                            _pll_ordinal(index),
                        )
                    )
                out.append(v if counting else float(v))
                continue
            raise TypeError(self._not_numeric(name, v, index, op, swap_with))
        return out

    def _looks_numeric(self, name):
        """Whether a column is numbers written as text, rather than words.

        What separates `"1123"`, which only needs converting, from `"Mon"`,
        which is simply not a number - and so decides whether advising
        `transform_column(..., float)` would help or mislead.
        """
        values = [v for v in self._data[name] if v is not None and v != ""]
        if not values:
            return False
        numeric = sum(1 for v in values if _pll_reads_as_number(v))
        return numeric * 2 >= len(values)

    def _not_numeric(self, name, value, index, op, swap_with):
        """Why `op` cannot use this column, and what would fix it."""
        base = (
            "%s needs a column of numbers, but column %s holds %s in the %s row"
            % (op, _pll_q(name), _pll_describe(value), _pll_ordinal(index))
        )
        # Arguments the wrong way round: the labels column was given where
        # the measured one belongs, and the other one is the numbers.
        if (
            swap_with is not None
            and not self._looks_numeric(name)
            and self._looks_numeric(swap_with)
        ):
            return "%s. %s takes the labels column first: %s(%s, %s)." % (
                base,
                op,
                op,
                _pll_q(name),
                _pll_q(swap_with),
            )
        if self._looks_numeric(name):
            # Numbers written as text, which is every column of a CSV.
            return (
                "%s. Values read from a CSV are text until they are "
                "converted: transform_column(%s, float) first."
                % (base, _pll_q(name))
            )
        return "%s. That column holds text, so there is nothing to measure." % base


def _pll_check_column_name(name, who):
    if not isinstance(name, str):
        raise TypeError(
            "%s's column name has to be a string, like \"total\", but it is %s."
            % (who, _pll_describe(name))
        )


def _pll_row_count(n, who):
    """How many rows `head` or `tail` is asked for: a whole number, not negative."""
    if isinstance(n, bool) or not isinstance(n, _pll_tbl_numbers.Integral):
        raise TypeError(
            "%s takes how many rows to keep, as a whole number like %s(5), but it "
            "was given %s." % (who, who, _pll_describe(n))
        )
    if n < 0:
        raise ValueError(
            "%s takes how many rows to keep, which cannot be negative, but it is %d."
            % (who, n)
        )
    return int(n)


def _pll_row_values(row, cols, index, who):
    """One row's values, in the order of `cols`, checked."""
    if isinstance(row, dict):
        unknown = [key for key in row if key not in cols]
        if unknown:
            suggestion, note = _pll_closest(unknown[0], cols)
            raise ValueError(
                "the %s row has %s, which is not one of the columns (%s).%s%s"
                % (
                    _pll_ordinal(index),
                    _pll_q(unknown[0]),
                    ", ".join(cols),
                    " Did you mean %s?" % _pll_q(suggestion) if suggestion else "",
                    note,
                )
            )
        return [row.get(c) for c in cols]
    if isinstance(row, str) or not hasattr(row, "__iter__"):
        # `table(columns, ["Jan", 1])` - the values of one row where a list
        # of rows belongs. Iterating it would take a string apart into
        # letters and blame the wrong thing.
        if who == "add_row":
            raise TypeError(
                "add_row takes one row, as a list of values or a dict, but it was "
                "given %s." % _pll_describe(row)
            )
        raise TypeError(
            "each row should be a list of values, but the %s row is "
            "%s. Put every row inside one outer list: "
            "table(columns, [[...], [...]])."
            % (_pll_ordinal(index), _pll_describe(row))
        )
    values = list(row)
    if len(values) != len(cols):
        raise ValueError(
            "the %s row, %s, has %d value%s, but the table has %d "
            "columns: %s"
            % (
                _pll_ordinal(index),
                _pll_literal(values),
                len(values),
                "" if len(values) == 1 else "s",
                len(cols),
                ", ".join(cols),
            )
        )
    return values


def _pll_table_differences(left, right):
    """Where two tables differ, for a failed `assert left == right`, or None.

    A table's repr shows its first rows, which are the same in two tables
    that differ further down.
    """
    if not (isinstance(left, Table) and isinstance(right, Table)):
        return None
    if left._columns != right._columns:
        return [
            "The columns differ: %s and %s."
            % (_pll_literal(left._columns, 200), _pll_literal(right._columns, 200))
        ]
    lines = []
    if left._length != right._length:
        lines.append("The first has %d rows and the second %d." % (left._length, right._length))
    differ = [
        i
        for i in range(min(left._length, right._length))
        if any(left._data[c][i] != right._data[c][i] for c in left._columns)
    ]
    if differ:
        i = differ[0]
        lines.append(
            "Row %d is the first that differs: %r and %r%s."
            % (
                i,
                [left._data[c][i] for c in left._columns],
                [right._data[c][i] for c in left._columns],
                " (%d more rows differ)" % (len(differ) - 1) if len(differ) > 1 else "",
            )
        )
    return lines


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
    if not isinstance(data, dict):
        raise TypeError(
            "table_from_columns takes one dictionary, from each column's name to "
            'its values: table_from_columns({"month": ["Jan", "Feb"], "riders": [1, 2]}) - '
            "but it was given %s." % _pll_describe(data)
        )
    cols = list(data.keys())
    for c in cols:
        _pll_check_column_name(c, "table_from_columns")
        values = data[c]
        # One string is iterable, and would become a column of its letters.
        if isinstance(values, (str, dict)) or not hasattr(values, "__iter__"):
            raise TypeError(
                "table_from_columns needs a list of values for each column, but "
                "%s is %s." % (_pll_q(c), _pll_describe(values))
            )
    columns = {c: list(data[c]) for c in cols}
    lengths = {c: len(columns[c]) for c in cols}
    if len(set(lengths.values())) > 1:
        first, other = cols[0], next(c for c in cols if lengths[c] != lengths[cols[0]])
        raise ValueError(
            "table_from_columns needs every column to be the same length, but "
            "%s has %d value%s and %s has %d."
            % (
                _pll_q(first),
                lengths[first],
                "" if lengths[first] == 1 else "s",
                _pll_q(other),
                lengths[other],
            )
        )
    return Table._from_columns(cols, columns, lengths[cols[0]] if cols else 0)


def _pll_refuse_html(text, source):
    """Stop early when the address gave a web page rather than a CSV.

    A GitHub file's own address serves the page you look at in a browser,
    not the file, and the page parsed as CSV produced "Line 15 of '...' has
    9 value(s) but there are 1 columns (<!DOCTYPE html>)" - a message about
    a line nobody wrote.
    """
    start = text.lstrip("\ufeff \t\r\n")
    # Past any comments: a page may start with one.
    while start.startswith("<!--"):
        end = start.find("-->")
        if end < 0:
            break
        start = start[end + 3:].lstrip()
    start = start[:200].lower()
    if not (start.startswith("<!doctype html") or start.startswith("<html")):
        return
    hint = ""
    if "github.com" in str(source):
        hint = (
            " On GitHub, open the file and use the address behind the Raw "
            "button (raw.githubusercontent.com)."
        )
    raise ValueError(
        '"%s" gave back a web page, not a CSV file.%s' % (source, hint)
    )


def load_table(source):
    """Read a CSV into a table, from a file beside your program or a URL.

    Which one is worked out from the text: anything starting `http://` or
    `https://` is fetched, anything else is a file name.

        load_table("cars.csv")
        load_table("https://example.edu/cars.csv")

    The first row names the columns. **Every cell arrives as text**, the
    way Pyret's `load-table` gives it to you, including ones that look like
    numbers; an empty cell is the empty string. Convert a column when you
    want to chart or average it:

        cars = load_table("cars.csv").transform_column("mpg", float)

    Guessing which columns are numeric reads well in the easy case and
    badly in the rest: a column of years or zip codes becomes arithmetic
    nobody asked for, a stray "n/a" silently turns a numeric column back
    into text, and either way what a table holds depends on the file
    rather than on the program. Converting explicitly is one more line and
    says what it means.
    """
    text = _pll_read_source(source, "load_table")
    _pll_refuse_html(text, source)
    records = _pll_csv_records(text, source)

    def blank(row):
        return not any(cell.strip() for cell in row)

    # Blank lines before the names and after the last row are not rows; an
    # editor or a spreadsheet leaves them there.
    while records and blank(records[0][1]):
        records.pop(0)
    while records and blank(records[-1][1]):
        records.pop()
    if not records:
        raise ValueError("%r has no rows in it." % source)

    header = [name.strip() for name in records[0][1]]
    if len(header) != len(set(header)):
        seen = set()
        for name in header:
            if name in seen:
                raise ValueError(
                    "%s has two columns called %s. Column names have to be "
                    "different, so give one of them another name."
                    % (_pll_q(source), _pll_q(name))
                )
            seen.add(name)
    blank_names = [i for i, name in enumerate(header) if not name]
    if blank_names:
        raise ValueError(
            "Column %d of %r has no name in the first row." % (blank_names[0] + 1, source)
        )

    raw = {name: [] for name in header}
    length = 0
    for line, row in records[1:]:
        if not row or (len(row) == 1 and not row[0].strip()):
            # An empty line: in a file of one column, an empty cell, and in
            # any other just a gap between rows.
            if len(header) != 1:
                continue
            row = [""]
        if len(row) != len(header):
            raise ValueError(
                "Line %d of %r has %d value(s) but there are %d columns (%s)."
                % (line, source, len(row), len(header), ", ".join(header))
            )
        for name, cell in zip(header, row):
            raw[name].append(cell)
        length += 1

    return Table._from_columns(header, raw, length)


def _pll_csv_records(text, source):
    """`(line, cells)` for each record of a CSV, with the line it starts on.

    `csv` rather than `split(",")`: quoted fields containing commas and
    newlines are ordinary in real data, and getting them wrong shifts every
    later column without saying anything. Strict, so a quote never closed
    is an error rather than the rest of the file in one cell.
    """
    reader = _csv.reader(_io.StringIO(text), strict=True)
    records = []
    line = 1
    try:
        for row in reader:
            records.append((line, row))
            line = reader.line_num + 1
    except _csv.Error as e:
        if "unexpected end of data" in str(e):
            raise ValueError(
                '%s has a quote (") on line %d that is never closed, so everything '
                "after it would be one cell. Close the quote, or take it out."
                % (_pll_q(source), line)
            ) from None
        raise ValueError(
            "Could not read %s as a CSV: line %d: %s" % (_pll_q(source), line, e)
        ) from None
    return records


def function_plot(f, x_min, x_max, steps=200, title=None):
    """Plot `f` over the range `x_min` to `x_max`.

    The range is required, unlike Pyret's `function-plot`, which borrows a
    window from the chart it is drawn into. There is no such window here,
    and guessing one would quietly decide what the picture shows.

        function_plot(lambda x: x * x, -3, 3)

    Where `f` has no value - 1/x at 0, a square root below 0 - the line
    has a gap.
    """
    _pll_check_function(f, "function_plot", "one number")
    for name, value in (("x_min", x_min), ("x_max", x_max)):
        if not _pll_is_number(value) or not _math.isfinite(value):
            raise TypeError(
                "function_plot's `%s` has to be a number, but it is %s."
                % (name, _pll_describe(value))
            )
    if x_max <= x_min:
        raise ValueError("function_plot needs x_max to be greater than x_min")
    if isinstance(steps, bool) or not isinstance(steps, _pll_tbl_numbers.Integral) or steps < 2:
        raise ValueError(
            "function_plot's `steps` has to be a whole number, at least 2, but it is %s."
            % _pll_describe(steps)
        )
    xs = []
    ys = []
    starts = []
    gap = True
    failed = None
    for i in range(steps + 1):
        x = x_min + (x_max - x_min) * i / steps
        try:
            value = _to_number(f(x))
        except (ZeroDivisionError, ValueError, OverflowError) as e:
            # No value here: math's own errors, for 1/x at 0 or log of 0.
            failed = failed or e
            value = None
        if value is None:
            gap = True
            continue
        if gap:
            starts.append(len(xs))
            gap = False
        xs.append(x)
        ys.append(value)
    if not xs and failed is not None:
        # Nowhere at all: that is not a gap but the function failing.
        raise failed
    if len(xs) < 2:
        raise ValueError(
            "function_plot found no numbers to draw between x=%s and x=%s"
            % (_pll_number(x_min), _pll_number(x_max))
        )
    return _PllChart(
        _render_xy_chart(xs, ys, "x", "y", title, mode="line", markers=False, starts=starts)
    )


# -----------------------------------------------------------------------------
# Numeric helpers
# -----------------------------------------------------------------------------

def _to_number(value):
    if isinstance(value, bool):
        return float(value)
    if _pll_is_number(value):
        try:
            number = float(value)
        except OverflowError:
            return None
        return number if _math.isfinite(number) else None
    return None


def _pll_reads_as_number(value):
    """Whether this value *could* be a number.

    Wider than `_to_number`, which refuses a string on purpose: this is
    only for deciding whether to suggest a conversion, and `"29"` from a
    CSV is exactly the case where suggesting one is right.
    """
    if _to_number(value) is not None:
        return True
    if not isinstance(value, str):
        return False
    try:
        float(value.strip())
    except ValueError:
        return False
    return True


def _sum_numeric(values):
    return sum(values)


def _sort_key(value):
    """Sort key tolerant of mixed None/str/numeric columns.

    NaN after every number: it compares as neither larger nor smaller, so
    among numbers it would leave the order as it found it.
    """
    if value is None:
        return (0, 0)
    if isinstance(value, bool):
        return (1, int(value))
    if _pll_is_number(value):
        if value != value:
            return (1.5, 0)
        return (1, value)
    if isinstance(value, str):
        return (2, value)
    return (3, repr(value))


# -----------------------------------------------------------------------------
# Chart rendering
# -----------------------------------------------------------------------------
#
# Charts are pure SVG, made into a `_PllChart` - an `Image` from the image
# library, loaded before this one into the same globals - so a chart is
# displayed, `beside`d and annotated `-> Image` like any picture.

_CHART_W = 480
_CHART_H = 320
_CHART_MARGIN_L = 56
_CHART_MARGIN_R = 16
_CHART_MARGIN_T = 28  # space for title
_CHART_MARGIN_B = 44


class _PllChart(_Drawing):
    """A chart: an image, which displays and combines like any other."""

    def __init__(self, svg_payload):
        # svg_payload: {"width", "height", "data"}
        _Drawing.__init__(self, svg_payload["data"], svg_payload["width"], svg_payload["height"])

    def __repr__(self):
        return "<Chart %dx%d>" % (_pll_px(self._w), _pll_px(self._h))


def _plot_box(height=None):
    """Inner plotting rectangle: (x, y, w, h)."""
    x = _CHART_MARGIN_L
    y = _CHART_MARGIN_T
    w = _CHART_W - _CHART_MARGIN_L - _CHART_MARGIN_R
    h = (_CHART_H if height is None else height) - _CHART_MARGIN_T - _CHART_MARGIN_B
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


def _chart_frame(title, x_label, y_label, body_svg, height=None):
    """Wrap chart body SVG with title + axis labels + outer <svg>."""
    chart_h = _CHART_H if height is None else height
    px, py, pw, ph = _plot_box(height)
    title_svg = ""
    if title:
        title_svg = (
            '<text x="%d" y="%d" text-anchor="middle" '
            'font-size="13" font-weight="600">%s</text>'
        ) % (_CHART_W / 2, _CHART_MARGIN_T - 12, _pll_xml_escape(title))

    x_label_svg = (
        '<text x="%d" y="%d" text-anchor="middle" '
        'font-size="11" font-style="italic">%s</text>'
    ) % (px + pw / 2, chart_h - 8, _pll_xml_escape(x_label))

    # y-label rotated 90deg, anchored on the left margin
    y_label_svg = (
        '<text x="%d" y="%d" text-anchor="middle" font-size="11" '
        'font-style="italic" transform="rotate(-90 %d %d)">%s</text>'
    ) % (16, py + ph / 2, 16, py + ph / 2, _pll_xml_escape(y_label))

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
        'viewBox="0 0 %d %d" font-family="sans-serif" '
        'shape-rendering="geometricPrecision">'
        '<rect x="0" y="0" width="%d" height="%d" fill="white"/>'
        "%s%s%s%s</svg>"
    ) % (
        _CHART_W,
        chart_h,
        _CHART_W,
        chart_h,
        _CHART_W,
        chart_h,
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
            % (px - 6, y, _pll_xml_escape(_format_tick(t)))
        )
    # Axis line.
    parts.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#888"/>' % (px, py, px, py + ph))
    parts.append("</g>")
    return "".join(parts) + "".join(text_parts)


def _draw_x_axis_numeric(lo, hi, ticks, height=None):
    px, py, pw, ph = _plot_box(height)
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
            % (x, py + ph + 14, _pll_xml_escape(_format_tick(t)))
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
                'fill="#444">%s</text>' % (cx, py + ph + 14, _pll_xml_escape(label))
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


#: Series colours, reused for labelled groups and pie slices. Ordered so
#: neighbouring series stay distinguishable rather than shading into one
#: another.
_PALETTE = (
    "#4f8cff", "#f2994a", "#27ae60", "#eb5757",
    "#9b51e0", "#2d9cdb", "#f2c94c", "#56ccf2",
)


def _palette(i):
    return _PALETTE[i % len(_PALETTE)]


def _plain_frame(title, body_svg, width=_CHART_W, height=_CHART_H):
    """An outer <svg> with a title and no axes, for charts that have none."""
    title_svg = ""
    if title:
        title_svg = (
            '<text x="%d" y="%d" text-anchor="middle" '
            'font-size="13" font-weight="600">%s</text>'
        ) % (width / 2, _CHART_MARGIN_T - 12, _pll_xml_escape(title))
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
        'viewBox="0 0 %d %d" font-family="sans-serif" '
        'shape-rendering="geometricPrecision">'
        '<rect x="0" y="0" width="%d" height="%d" fill="white"/>'
        "%s%s</svg>"
    ) % (width, height, width, height, width, height, title_svg, body_svg)


def _legend_width(entries):
    """How wide the key needs to be: swatch, gap, text, padding.

    A shared estimate, because the caller positions the panel and the
    panel draws itself - and when the two disagreed by a few pixels the
    last letter of a short label was clipped off the edge of the chart.
    """
    longest = max(len(str(label)) for _, label in entries)
    return 24.0 + longest * 6.2


def _render_legend(entries, x, y):
    """A colour/label key, on a backing panel so it stays readable on data."""
    if not entries:
        return ""
    rows = []
    box_w = _legend_width(entries)
    box_h = 6 + len(entries) * 14
    rows.append(
        '<rect x="%g" y="%g" width="%g" height="%g" fill="white" '
        'fill-opacity="0.85" stroke="#ddd"/>' % (x, y, box_w, box_h)
    )
    for i, (color, label) in enumerate(entries):
        cy = y + 10 + i * 14
        rows.append('<rect x="%g" y="%g" width="8" height="8" fill="%s"/>'
                    % (x + 5, cy - 6, color))
        rows.append(
            '<text x="%g" y="%g" font-size="10" fill="#333">%s</text>'
            % (x + 18, cy + 1, _pll_xml_escape(label))
        )
    return "".join(rows)


def _pll_linear_fit(xs, ys):
    """Least-squares fit. Returns (slope, intercept, r_squared)."""
    n = len(xs)
    if n < 2:
        raise ValueError("a line of best fit needs at least two rows")
    mean_x = _sum_numeric(xs) / n
    mean_y = _sum_numeric(ys) / n
    sxx = _sum_numeric([(x - mean_x) ** 2 for x in xs])
    sxy = _sum_numeric([(x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)])
    if sxx == 0:
        raise ValueError(
            "a line of best fit needs the x values to vary; they are all %g"
            % mean_x
        )
    slope = sxy / sxx
    intercept = mean_y - slope * mean_x
    ss_tot = _sum_numeric([(y - mean_y) ** 2 for y in ys])
    ss_res = _sum_numeric([(y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys)])
    # All y equal: the line goes through every point, so it explains
    # everything there is to explain.
    r_squared = 1.0 if ss_tot == 0 else 1.0 - ss_res / ss_tot
    return slope, intercept, r_squared


def _fit_title(slope, intercept, r_squared):
    """Pyret's wording, so a course can use either and read the same thing."""
    sign = "+" if intercept >= 0 else "-"
    return "y=%.3fx %s %.3f;     r-sq: %.3f" % (
        slope, sign, abs(intercept), r_squared,
    )


def _quartiles(values):
    """(q1, median, q3) by linear interpolation.

    The same rule as `statistics.quantiles(..., method="inclusive")` and
    numpy's default percentile, so a student can check the box by hand
    against what those report.
    """
    ordered = sorted(values)
    n = len(ordered)

    def at(fraction):
        if n == 1:
            return ordered[0]
        pos = fraction * (n - 1)
        low = int(_math.floor(pos))
        high = min(low + 1, n - 1)
        return ordered[low] + (ordered[high] - ordered[low]) * (pos - low)

    return at(0.25), at(0.5), at(0.75)


def _render_xy_chart(xs, ys, x_label, y_label, title, mode, labels=None, lines=(), markers=True, starts=(0,)):
    """Points, optionally grouped by label and overlaid with fitted lines.

    One renderer for scatter, line, labelled scatter and the regression
    plots: they differ only in how points are coloured and whether a line
    is drawn through them, so the axis and tick work is not worth
    duplicating four times. `starts` are the points a line starts afresh
    at, after a gap.
    """
    px, py, pw, ph = _plot_box()
    if not xs:
        body = ""
        return {
            "width": _CHART_W,
            "height": _CHART_H,
            "data": _chart_frame(title, x_label, y_label, body),
        }

    # A fitted line can reach past the points, so the axes have to cover it
    # too or it would be clipped at the edge of the box.
    all_x = list(xs) + [x for line in lines for x in line[0]]
    all_y = list(ys) + [y for line in lines for y in line[1]]
    x_lo, x_hi = min(all_x), max(all_x)
    y_lo, y_hi = min(all_y), max(all_y)
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
        lifted = set(starts)
        path = " ".join(
            "%s %g %g" % ("M" if i in lifted or i == 0 else "L", sx, sy)
            for i, (sx, sy) in enumerate(coords)
        )
        body.append(
            '<path d="%s" fill="none" stroke="#4f8cff" stroke-width="2" '
            'stroke-linejoin="round" stroke-linecap="round"/>' % path
        )
        if markers:
            for sx, sy in coords:
                body.append(
                    '<circle cx="%g" cy="%g" r="2.5" fill="#4f8cff"/>' % (sx, sy)
                )
    elif labels is None:
        for x, y in zip(xs, ys):
            sx, sy = to_px(x, y)
            body.append(
                '<circle cx="%g" cy="%g" r="3" fill="#4f8cff" opacity="0.7"/>'
                % (sx, sy)
            )
    else:
        # One colour per distinct label, in the order they first appear, so
        # the key reads in the same order as the table.
        order = []
        for label in labels:
            if label not in order:
                order.append(label)
        colors = {label: _palette(i) for i, label in enumerate(order)}
        for x, y, label in zip(xs, ys, labels):
            sx, sy = to_px(x, y)
            body.append(
                '<circle cx="%g" cy="%g" r="3.5" fill="%s" opacity="0.85"/>'
                % (sx, sy, colors[label])
            )
        legend = [(colors[label], label) for label in order]
        # Above a handful of series a key is a wall of text; the colours
        # still separate the groups.
        if len(legend) <= 8:
            body.append(
                _render_legend(legend, px + pw - _legend_width(legend) - 4, py + 4)
            )

    for line_xs, line_ys in lines:
        coords = [to_px(x, y) for x, y in zip(line_xs, line_ys)]
        if len(coords) < 2:
            continue
        body.append(
            '<path d="%s" fill="none" stroke="#eb5757" stroke-width="2"/>'
            % ("M " + " L ".join("%g %g" % (sx, sy) for sx, sy in coords))
        )
    return {
        "width": _CHART_W,
        "height": _CHART_H,
        "data": _chart_frame(title, x_label, y_label, "".join(body)),
    }


def _render_pie_chart(labels, values, title, column):
    """Slices plus a key, with each slice's share of the total."""
    total = _sum_numeric(values)
    if total <= 0:
        raise ValueError(
            "a pie chart needs the values in column %s to add up to more than "
            "zero, but they add up to %s." % (_pll_q(column), _pll_number(total))
        )
    cx, cy = _CHART_W * 0.32, _CHART_MARGIN_T + 124
    radius = 108
    body = []
    legend = []
    angle = -_math.pi / 2  # start at twelve o'clock
    for i, (label, value) in enumerate(zip(labels, values)):
        if value <= 0:
            continue
        share = value / total
        sweep = share * 2 * _math.pi
        end = angle + sweep
        color = _palette(i)
        if share >= 0.999:
            # A single slice is a whole circle: an arc from a point back to
            # itself draws nothing at all.
            body.append('<circle cx="%g" cy="%g" r="%g" fill="%s"/>' % (cx, cy, radius, color))
        else:
            x1, y1 = cx + radius * _math.cos(angle), cy + radius * _math.sin(angle)
            x2, y2 = cx + radius * _math.cos(end), cy + radius * _math.sin(end)
            body.append(
                '<path d="M %g %g L %g %g A %g %g 0 %d 1 %g %g Z" fill="%s" '
                'stroke="white" stroke-width="1"/>'
                % (cx, cy, x1, y1, radius, radius, 1 if sweep > _math.pi else 0, x2, y2, color)
            )
        legend.append((color, "%s (%.1f%%)" % (label, share * 100)))
        angle = end
    body.append(_render_legend(legend, _CHART_W * 0.62, _CHART_MARGIN_T + 4))
    return {
        "width": _CHART_W,
        "height": _CHART_H,
        "data": _plain_frame(title, "".join(body)),
    }


#: A box plot has one row of data, so it gets a strip like the dot plot
#: rather than a square with the box stranded in the middle of it.
_BOX_PLOT_H = _CHART_MARGIN_T + 96 + _CHART_MARGIN_B


def _render_box_plot(values, name, title):
    """A box from the quartiles, whiskers to 1.5*IQR, outliers as points."""
    px, py, pw, ph = _plot_box(_BOX_PLOT_H)
    q1, median, q3 = _quartiles(values)
    iqr = q3 - q1
    inside = [v for v in values if q1 - 1.5 * iqr <= v <= q3 + 1.5 * iqr]
    low = min(inside) if inside else min(values)
    high = max(inside) if inside else max(values)
    outliers = [v for v in values if v < low or v > high]

    ticks, lo_n, hi_n = _nice_ticks(min(values), max(values), target=6)

    def to_x(v):
        if hi_n <= lo_n:
            return px + pw / 2
        return px + (v - lo_n) / (hi_n - lo_n) * pw

    mid = py + ph * 0.58
    half = ph * 0.26
    body = [_draw_x_axis_numeric(lo_n, hi_n, ticks, _BOX_PLOT_H)]
    body.append(
        '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#444"/>'
        % (to_x(low), mid, to_x(high), mid)
    )
    for v in (low, high):
        body.append(
            '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#444"/>'
            % (to_x(v), mid - half * 0.5, to_x(v), mid + half * 0.5)
        )
    body.append(
        '<rect x="%g" y="%g" width="%g" height="%g" fill="#4f8cff" '
        'fill-opacity="0.35" stroke="#4f8cff"/>'
        % (to_x(q1), mid - half, max(to_x(q3) - to_x(q1), 1.0), half * 2)
    )
    body.append(
        '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#1b4fa0" stroke-width="2"/>'
        % (to_x(median), mid - half, to_x(median), mid + half)
    )
    for v in outliers:
        body.append(
            '<circle cx="%g" cy="%g" r="3" fill="none" stroke="#eb5757"/>'
            % (to_x(v), mid)
        )
    summary = "min %s  q1 %s  median %s  q3 %s  max %s" % tuple(
        _format_tick(v) for v in (low, q1, median, q3, high)
    )
    body.append(
        '<text x="%g" y="%g" font-size="10" fill="#555" text-anchor="middle">%s</text>'
        % (px + pw / 2, py + 10, _pll_xml_escape(summary))
    )
    return {
        "width": _CHART_W,
        "height": _BOX_PLOT_H,
        "data": _chart_frame(title, name, "", "".join(body), _BOX_PLOT_H),
    }


_DOT_RADIUS = 5.0


def _render_dot_plot(values, labels, name, title):
    """One dot per row, stacked where rows share a value.

    Sized to the tallest stack rather than to `_CHART_H`, and with no
    y-axis. Stacking says "two rows had this value", which is not a
    quantity to put a scale against - and a full-height square left the
    dots marooned on the bottom axis under an empty y-axis labelled
    "count".
    """
    tallest = 1
    tally = {}
    for v in values:
        tally[v] = tally.get(v, 0) + 1
        tallest = max(tallest, tally[v])
    stack_h = tallest * (_DOT_RADIUS * 2 + 1) + _DOT_RADIUS
    # The key sits inside the plot area, so the strip has to be tall enough
    # to hold it - otherwise a tall stack at the right-hand end draws
    # straight through it.
    keys = len({label for label in labels}) if labels is not None else 0
    legend_h = (6 + keys * 14 + 8) if 0 < keys <= 8 else 0
    chart_h = (
        _CHART_MARGIN_T
        + max(64.0, stack_h + 10, legend_h + stack_h)
        + _CHART_MARGIN_B
    )
    px, py, pw, ph = _plot_box(chart_h)
    ticks, lo_n, hi_n = _nice_ticks(min(values), max(values), target=6)

    def to_x(v):
        if hi_n <= lo_n:
            return px + pw / 2
        return px + (v - lo_n) / (hi_n - lo_n) * pw

    order = []
    if labels is not None:
        for label in labels:
            if label not in order:
                order.append(label)
    colors = {label: _palette(i) for i, label in enumerate(order)}

    body = [_draw_x_axis_numeric(lo_n, hi_n, ticks, chart_h)]
    seen = {}
    for i, v in enumerate(values):
        level = seen.get(v, 0)
        seen[v] = level + 1
        cy = py + ph - _DOT_RADIUS - level * (_DOT_RADIUS * 2 + 1)
        fill = colors[labels[i]] if labels is not None else "#4f8cff"
        body.append(
            '<circle cx="%g" cy="%g" r="%g" fill="%s" opacity="0.85"/>'
            % (to_x(v), cy, _DOT_RADIUS, fill)
        )
    if order and len(order) <= 8:
        legend = [(colors[label], label) for label in order]
        body.append(
            _render_legend(legend, px + pw - _legend_width(legend) - 4, py + 2)
        )
    return {
        "width": _CHART_W,
        "height": chart_h,
        "data": _chart_frame(title, name, "", "".join(body), chart_h),
    }


def _render_histogram(values, bins, name, title, bin_width=None):
    """Counts per bucket: `bins` of them across the values, or buckets
    `bin_width` wide starting at a multiple of it, so ages grouped by 5
    are 20-25, 25-30, ...
    """
    px, py, pw, ph = _plot_box()
    if not values:
        body = ""
        return {
            "width": _CHART_W,
            "height": _CHART_H,
            "data": _chart_frame(title, name, "count", body),
        }

    lo, hi = min(values), max(values)
    if bin_width is not None:
        width = float(bin_width)
        lo = _math.floor(lo / width) * width
        bins = int((hi - lo) // width) + 1
        hi = lo + bins * width
    else:
        if hi == lo:
            hi = lo + 1.0  # avoid zero-width bins for constant data
        width = (hi - lo) / bins
    counts = [0] * bins
    for v in values:
        idx = min(int((v - lo) / width), bins - 1)
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
# Names exported into user globals by the install step.
# -----------------------------------------------------------------------------

PLL_TABLE_EXPORTS = [
    "Table",
    "Row",
    "table",
    "table_from_columns",
    "load_table",
    "function_plot",
]

# Each function says it is `pll.table`'s, so `help(load_table)` does.
for _pll_exported in PLL_TABLE_EXPORTS:
    _pll_value = globals()[_pll_exported]
    if callable(_pll_value) and not isinstance(_pll_value, type):
        _pll_value.__module__ = "pll.table"
del _pll_exported, _pll_value
