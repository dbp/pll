# PLL table library.
#
# A small, immutable table: named columns, and rows of values in them. It is
# stored column by column (a dict of name -> list of values), so changing or
# adding up one column touches only that column. Every operation returns a
# new `Table`; nothing mutates. Charts are images, drawn as SVG at the end of
# this file.

import csv as _csv
import io as _io
import math as _math
import numbers as _pll_tbl_numbers
import statistics as _pll_tbl_statistics
import sys as _pll_tbl_sys

#: Rows `repr(table)` shows before truncating, few enough not to bury the
#: rest of a message. A failed `==` between tables says where they differ
#: (`_pll_table_differences`), so the rows that matter are always shown.
_REPR_ROWS = 6

#: The most of a table's text the panel is given for Save CSV.
_PLL_CSV_LIMIT = 8 * 1024 * 1024


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


def _pll_bools_are_numbers():
    """Whether True and False count as 1 and 0 for the student's code: as in
    Python, except at the teaching levels, where neither is a number."""
    return _pll_student_level() not in _PLL_TEACHING_LEVELS


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
    # `hours-worked`. Too far for a spelling match, and still almost
    # certainly what was meant.
    starting = [c for c in candidates if c.lower().startswith(name.lower()) and name]
    if len(starting) == 1:
        return (starting[0], "")
    return (_pll_closest_name(name, candidates), "")


def _pll_no_column(name, columns, what="the table"):
    """The one wording for a column that is not there."""
    suggestion, note = _pll_closest(name, columns)
    return "%s has no column %s (it has: %s).%s%s" % (
        what,
        _pll_literal(name),
        ", ".join(columns),
        " Did you mean %s?" % _pll_literal(suggestion) if suggestion is not None else "",
        note,
    )


def _pll_function_name(fn):
    """`` `below_1k` `` for a message about a function the student passed."""
    name = getattr(fn, "__name__", None)
    return "`%s`" % name if name and name != "<lambda>" else "the function given"


def _pll_check_function(fn, who, takes):
    """A function argument, and not the result of calling one:
    `transform_column("servings", int())`."""
    if not callable(fn):
        raise TypeError(
            "%s needs a function, but got %s. %s calls your function with "
            "%s at a time, so give it the function's name with no brackets "
            "after it - `int`, not `int()`." % (who, _pll_describe(fn), who, takes)
        )
    return fn


def _pll_apply_to_cell(fn, value, index, name):
    """`fn(value)`, with the row and value named if a conversion fails.

    `transform_column("tickets", int)` on a column with one blank cell
    fails with "invalid literal for int() with base 10: ''", which says
    nothing about which row or which column. Only a conversion with no code
    of its own - `int`, `float` - is reworded: an error in a function of the
    student's goes on as it was raised, with its own line, to be explained
    like any other.
    """
    try:
        return fn(value)
    except (ValueError, TypeError) as exc:
        if (
            type(exc) not in (ValueError, TypeError)
            or hasattr(fn, "__code__")
            or hasattr(getattr(fn, "__init__", None), "__code__")
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
                _pll_literal(name),
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
    A row says what the table methods say.

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
                _pll_literal(list(self)[0] if self else "column"),
            )
        )


# -----------------------------------------------------------------------------
# The Table class
# -----------------------------------------------------------------------------

class Table:
    """A table: named columns, and rows of values in them.

    Make one with `table(columns, rows)` or `load_table("file.csv")`. A
    table never changes: every method that changes something gives back a
    new table.
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
            _pll_check_column_name(c, "table")
        _pll_check_repeated(cols, "table")
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

    @classmethod
    def _from_columns(cls, columns, data, length):
        """A table from columns already checked."""
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
        new_data = dict(self._data)
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
                % (_pll_literal(name), _pll_literal(name))
            )
        if callable(values_or_fn):
            new_values = [values_or_fn(row) for row in self.rows()]
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
                        _pll_literal(name),
                        self._length,
                    )
                )
        new_data = dict(self._data)
        new_data[name] = new_values
        return Table._from_columns(self._columns + [name], new_data, self._length)

    def add_row(self, row):
        """This table with `row` added at the end.

        `row` is a list of values in the order of the columns, or a dict
        from column names to values, as in `table(...)`.
        """
        values = _pll_row_values(row, self._columns, self._length, "add_row")
        new_data = {c: self._data[c] + [v] for c, v in zip(self._columns, values)}
        return Table._from_columns(self._columns, new_data, self._length + 1)

    def select_columns(self, names):
        """Keep only the columns in `names`, in that order."""
        # One string is iterable, so `select_columns("name")` would come
        # apart into letters and complain about a column called 'n'.
        if isinstance(names, str):
            raise TypeError(
                "select_columns takes a list of column names, like [%s] - "
                "not one name on its own." % _pll_literal(names)
            )
        names = list(names)
        for n in names:
            self._require_column(n)
        repeated = sorted({n for n in names if names.count(n) > 1})
        if repeated:
            raise ValueError(
                "select_columns was given %s more than once; a table cannot "
                "have two columns of one name." % ", ".join(map(_pll_literal, repeated))
            )
        return Table._from_columns(names, self._data, self._length)

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
        numbers = _pll_bools_are_numbers()
        # Sort indices to keep all columns in lockstep.
        order = sorted(
            range(self._length),
            key=lambda i: _sort_key(values[i], numbers),
            reverse=not ascending,
        )
        new_data = {c: [self._data[c][i] for i in order] for c in self._columns}
        return Table._from_columns(self._columns, new_data, self._length)

    def head(self, n=10):
        """First `n` rows as a new table."""
        n = _pll_check_number(n, "head", "n", least=0, whole=True)
        return self._slice(0, min(n, self._length))

    def tail(self, n=10):
        """Last `n` rows as a new table."""
        n = _pll_check_number(n, "tail", "n", least=0, whole=True)
        return self._slice(max(0, self._length - n), self._length)

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
        return self._extreme(name, "min", "no smallest value", min)

    def max(self, name):
        """Maximum value in `name`."""
        return self._extreme(name, "max", "no largest value", max)

    def _extreme(self, name, op, none, pick):
        self._require_column(name)
        if self._length == 0:
            raise ValueError(self._empty(op, none))
        self._refuse_numbers_as_text(name, op, "compares")
        numbers = _pll_bools_are_numbers()
        return pick(self._data[name], key=lambda v: _sort_key(v, numbers))

    # ---- Charts ----

    def bar_chart(self, x, y, title=None):
        """Bar chart: one bar per row, x as label, y as height."""
        self._require_column(x)
        values = self._chart_values(y, "bar_chart", swap_with=x)
        return _bar_chart([_format_cell(v) for v in self._data[x]], values, x, y, title)

    def scatter_chart(self, x, y, title=None):
        """Scatter plot of x vs y (both numeric)."""
        return self._xy("scatter_chart", x, y, title)

    def scatter_plot(self, x, y, title=None):
        """Scatter plot of x vs y. Another name for `scatter_chart`."""
        return self._xy("scatter_plot", x, y, title)

    def line_chart(self, x, y, title=None):
        """Line chart of x vs y (both numeric, sorted by x)."""
        return self._xy("line_chart", x, y, title, mode="line")

    def labeled_scatter_plot(self, labels, x, y, title=None):
        """Scatter plot with the points coloured and keyed by `labels`."""
        return self._xy("labeled_scatter_plot", x, y, title, labels)

    def lr_plot(self, x, y, title=None):
        """Scatter plot with the line of best fit, and r-squared in the title."""
        return self._xy("lr_plot", x, y, title, fit=True)

    def labeled_lr_plot(self, labels, x, y, title=None):
        """`lr_plot`, with the points coloured and keyed by `labels`."""
        return self._xy("labeled_lr_plot", x, y, title, labels, fit=True)

    def _xy(self, who, x, y, title, labels=None, fit=False, mode="scatter"):
        """`y` against `x`: the points, coloured by `labels`, with the line
        of best fit through them when asked."""
        if labels is not None:
            self._require_column(labels)
        xs = self._chart_values(x, who)
        ys = self._chart_values(y, who)
        lines = ()
        if fit:
            slope, intercept, r_squared = _pll_linear_fit(xs, ys)
            lines = [([min(xs), max(xs)], [slope * min(xs) + intercept, slope * max(xs) + intercept])]
            if title is None:
                title = _fit_title(slope, intercept, r_squared)
        if mode == "line":
            # Sorted by x, so the line runs left to right.
            pairs = sorted(zip(xs, ys), key=lambda p: p[0])
            xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]
        names = [_format_cell(v) for v in self._data[labels]] if labels is not None else None
        return _xy_chart(xs, ys, x, y, title, mode, names, lines)

    def histogram(self, name, bins=10, bin_width=None, title=None):
        """Histogram of `name` (numeric).

        `bins` counts the buckets; `bin_width` sets how wide each one is
        instead, which is usually what the data calls for ("group ages by
        5"): the buckets then start at a multiple of the width.
        """
        values = self._chart_values(name, "histogram")
        if bin_width is None:
            bins = _pll_check_number(bins, "histogram", "bins", least=1, whole=True)
        else:
            bin_width = _pll_check_number(bin_width, "histogram", "bin_width", above=0)
        return _histogram(values, bins, name, title, bin_width)

    def pie_chart(self, labels, values, title=None):
        """Pie chart: one slice per row, sized by `values`."""
        self._require_column(labels)
        amounts = self._chart_values(values, "pie_chart")
        for index, amount in enumerate(amounts):
            if amount < 0:
                raise ValueError(
                    "a pie chart cannot show a negative value, but column %s "
                    "holds %s in the %s row."
                    % (_pll_literal(values), _pll_number(amount), _pll_ordinal(index))
                )
        return _pie_chart([_format_cell(v) for v in self._data[labels]], amounts, title, values)

    def dot_plot(self, name, title=None):
        """One dot per row along `name`, stacked where rows share a value."""
        return _dot_plot(self._chart_values(name, "dot_plot"), None, name, title)

    def labeled_dot_plot(self, labels, name, title=None):
        """`dot_plot`, with the dots coloured and keyed by `labels`."""
        self._require_column(labels)
        values = self._chart_values(name, "labeled_dot_plot")
        return _dot_plot(values, [_format_cell(v) for v in self._data[labels]], name, title)

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
        return _bar_chart(keys, [float(counts[k][1]) for k in keys], name, "count", title)

    def box_plot(self, name, title=None):
        """Box and whisker plot of `name`: quartiles, range and outliers."""
        return _box_plot(self._chart_values(name, "box_plot"), name, title)

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
            numeric.append(bool(cells) and all(_pll_real(v) for v in cells))
        csv_text, csv_rows = self._csv_text(_PLL_CSV_LIMIT)
        return {
            "kind": "table",
            "columns": list(self._columns),
            "rows": rows,
            "rowCount": n,
            "shownCount": shown,
            "truncated": n > shown,
            "numeric": numeric,
            "csv": csv_text,
            "csvRows": csv_rows,
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
        """This table as a pandas DataFrame. A program that calls this has
        pandas loaded for it before it runs."""
        import pandas as _pd

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
                "write t.column(%s) for the values in it." % _pll_literal(key)
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
                "the values in it." % _pll_literal(name),
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
                    _pll_literal(self._columns[0]) if self._columns else '"name"',
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
        """Stop `op` giving a wrong answer for numbers left as text.

        Text compares letter by letter, so "9" comes after "100". When every
        value in the column is a number written as text, and two of them are
        in a different order as text than as numbers, the column was almost
        certainly never converted.
        """
        texts = [v for v in self._data[name] if v is not None and v != ""]
        if not all(isinstance(t, str) for t in texts):
            return
        try:
            pairs = sorted((t, float(t)) for t in texts)
        except ValueError:
            return
        for (first, a), (second, b) in zip(pairs, pairs[1:]):
            if a > b:
                raise TypeError(
                    "%s %s column %s as text, and as text %s comes before %s: the "
                    "column holds numbers written as text, like those in quotes or "
                    "read from a CSV. Convert the column first: transform_column(%s, %s)."
                    % (
                        op,
                        does,
                        _pll_literal(name),
                        _pll_literal(first),
                        _pll_literal(second),
                        _pll_literal(name),
                        "int" if all(n.is_integer() for _, n in pairs) else "float",
                    )
                )

    def _numeric_column(self, name, op, swap_with=None, counting=False):
        """The column as numbers, or an error saying why it is not.

        `swap_with` is the other column of a two-column chart, so a chart
        given its arguments the wrong way round can say so. `counting` is
        for `sum` and `mean`, which keep each number as it is - whole
        numbers add up to a whole number. True and False are refused at the
        teaching levels, where neither is a number, and are 1 and 0 at the
        others, as in Python.
        """
        self._require_column(name)
        strict = not _pll_bools_are_numbers()
        out = []
        for index, v in enumerate(self._data[name]):
            if isinstance(v, bool):
                if strict:
                    raise TypeError(
                        "%s needs a column of numbers, but column %s holds %s in the "
                        "%s row. True and False are not numbers%s."
                        % (
                            op,
                            _pll_literal(name),
                            v,
                            _pll_ordinal(index),
                            "; to count the rows where it is True, filter on it and take the length"
                            if counting
                            else "",
                        )
                    )
                out.append(int(v) if counting else float(v))
                continue
            if _pll_real(v):
                if isinstance(v, float) and not _math.isfinite(v):
                    raise ValueError(
                        "%s needs numbers it can %s, but column %s holds %s in the %s "
                        "row. Leave such rows out first, with filter."
                        % (
                            op,
                            "add up" if counting else "draw",
                            _pll_literal(name),
                            "nan (\"not a number\")" if v != v else repr(v),
                            _pll_ordinal(index),
                        )
                    )
                out.append(v if counting else float(v))
                continue
            raise TypeError(self._not_numeric(name, v, index, op, swap_with))
        return out

    def _chart_values(self, name, op, swap_with=None):
        """A column of numbers to draw, from a table with rows to draw."""
        values = self._numeric_column(name, op, swap_with)
        if not values:
            raise ValueError(self._empty(op, "nothing to draw"))
        return values

    def _looks_numeric(self, name):
        """Whether a column is numbers written as text, rather than words.

        What separates `"1123"`, which only needs converting, from `"Mon"`,
        which is simply not a number - and so decides whether advising
        `transform_column(..., float)` would help or mislead.
        """
        values = [v for v in self._data[name] if v is not None and v != ""]
        return bool(values) and 2 * sum(map(_pll_could_be_number, values)) >= len(values)

    def _not_numeric(self, name, value, index, op, swap_with):
        """Why `op` cannot use this column, and what would fix it."""
        base = (
            "%s needs a column of numbers, but column %s holds %s in the %s row"
            % (op, _pll_literal(name), _pll_describe(value), _pll_ordinal(index))
        )
        # Arguments the wrong way round: the labels column was given where
        # the measured one belongs, and the other one is the numbers.
        if (
            swap_with is not None
            and not self._looks_numeric(name)
            and self._looks_numeric(swap_with)
        ):
            return "%s. %s takes the labels column first: %s(%s, %s)." % (
                base, op, op, _pll_literal(name), _pll_literal(swap_with),
            )
        if self._looks_numeric(name):
            # Numbers written as text, which is every column of a CSV.
            return (
                "%s. The column holds numbers written as text, like those in "
                "quotes or read from a CSV. Convert the column first: "
                "transform_column(%s, float)."
                % (base, _pll_literal(name))
            )
        return "%s. That column holds text, so there is nothing to measure." % base


def _pll_check_column_name(name, who):
    if not isinstance(name, str):
        raise TypeError(
            "%s's column name has to be a string, like \"total\", but it is %s."
            % (who, _pll_describe(name))
        )


def _pll_check_repeated(names, where):
    """Every column name once: a table, or a CSV's first row."""
    for i, name in enumerate(names):
        if name in names[:i]:
            raise ValueError(
                "%s has two columns called %s. Column names have to be "
                "different, so give one of them another name." % (where, _pll_literal(name))
            )


def _pll_row_values(row, cols, index, who):
    """One row's values, in the order of `cols`, checked."""
    if isinstance(row, dict):
        for key in row:
            if key not in cols:
                raise ValueError("the %s row: %s" % (_pll_ordinal(index), _pll_no_column(key, cols)))
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
    """Build a table from a `{name: list-of-values}` dict, its columns in
    the dict's order."""
    if not isinstance(data, dict):
        raise TypeError(
            "table_from_columns takes one dictionary, from each column's name to "
            'its values: table_from_columns({"month": ["Jan", "Feb"], "riders": [1, 2]}) - '
            "but it was given %s." % _pll_describe(data)
        )
    columns = {}
    for c, values in data.items():
        _pll_check_column_name(c, "table_from_columns")
        # One string is iterable, and would become a column of its letters.
        if isinstance(values, (str, dict)) or not hasattr(values, "__iter__"):
            raise TypeError(
                "table_from_columns needs a list of values for each column, but "
                "%s is %s." % (_pll_literal(c), _pll_describe(values))
            )
        columns[c] = list(values)
        first = next(iter(columns))
        if len(columns[c]) != len(columns[first]):
            raise ValueError(
                "table_from_columns needs every column to be the same length, but "
                "%s has %d value%s and %s has %d."
                % (
                    _pll_literal(first),
                    len(columns[first]),
                    "" if len(columns[first]) == 1 else "s",
                    _pll_literal(c),
                    len(columns[c]),
                )
            )
    return Table(list(columns), zip(*columns.values()))


def _pll_refuse_html(text, source):
    """Stop early when the address gave a web page rather than a CSV, as a
    GitHub file's own address does: parsed as CSV, the page's errors are
    about lines nobody wrote."""
    start = text.lstrip("﻿ \t\r\n")
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

    The first row names the columns. **Every cell arrives as text**,
    including ones that look like numbers; an empty cell is the empty
    string. Convert a column when you want to chart or average it:

        cars = load_table("cars.csv").transform_column("mpg", float)
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
    _pll_check_repeated(header, _pll_literal(source))
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
                % (_pll_literal(source), line)
            ) from None
        raise ValueError(
            "Could not read %s as a CSV: line %d: %s" % (_pll_literal(source), line, e)
        ) from None
    return records


def function_plot(f, x_min, x_max, steps=200, title=None):
    """Plot `f` over the range `x_min` to `x_max`.

    The range is required: there is no chart to borrow a window from, and
    guessing one would quietly decide what the picture shows.

        function_plot(lambda x: x * x, -3, 3)

    Where `f` has no value - 1/x at 0, a square root below 0 - the line
    has a gap.
    """
    _pll_check_function(f, "function_plot", "one number")
    x_min = _pll_check_number(x_min, "function_plot", "x_min")
    x_max = _pll_check_number(x_max, "function_plot", "x_max")
    if x_max <= x_min:
        raise ValueError("function_plot needs x_max to be greater than x_min")
    steps = _pll_check_number(steps, "function_plot", "steps", least=2, whole=True)
    xs = []
    ys = []
    starts = []
    gap = True
    failed = None
    numbers = _pll_bools_are_numbers()
    for i in range(steps + 1):
        x = x_min + (x_max - x_min) * i / steps
        try:
            got = f(x)
            value = float(got) if _pll_real(got) or isinstance(got, bool) else None
        except (ZeroDivisionError, ValueError, OverflowError) as e:
            # No value here: math's own errors, for 1/x at 0 or log of 0.
            failed = failed or e
            got = value = None
        if isinstance(got, bool) and not numbers:
            raise TypeError(
                "function_plot needs your function to give back numbers, but for x = %s it gave "
                "back %s. True and False are not numbers." % (_pll_number(x), got)
            )
        if value is None or not _math.isfinite(value):
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
    return _xy_chart(xs, ys, "x", "y", title, "line", markers=False, starts=starts)


# -----------------------------------------------------------------------------
# Numeric helpers
# -----------------------------------------------------------------------------

def _pll_could_be_number(value):
    """A number, or text that reads as one: `"29"` from a CSV is exactly
    the case where suggesting a conversion is right."""
    try:
        return _math.isfinite(float(value.strip() if isinstance(value, str) else value))
    except (TypeError, ValueError, OverflowError):
        return False


def _sort_key(value, bools_are_numbers=True):
    """Sort key tolerant of mixed None/str/numeric columns.

    NaN after every number: it compares as neither larger nor smaller, so
    among numbers it would leave the order as it found it. True and False
    are 1 and 0 - or, where they are not numbers, their own kind, after
    the numbers.
    """
    if value is None:
        return (0, 0)
    if isinstance(value, bool):
        return (1 if bools_are_numbers else 1.75, int(value))
    if _pll_real(value):
        if value != value:
            return (1.5, 0)
        return (1, value)
    if isinstance(value, str):
        return (2, value)
    return (3, repr(value))


def _pll_linear_fit(xs, ys):
    """Least squares: (slope, intercept, r_squared)."""
    if len(xs) < 2:
        raise ValueError("a line of best fit needs at least two rows")
    if len(set(xs)) == 1:
        raise ValueError("a line of best fit needs the x values to vary; they are all %g" % xs[0])
    slope, intercept = _pll_tbl_statistics.linear_regression(xs, ys)
    # All y equal: the line goes through every point, so it explains
    # everything there is to explain.
    r_squared = 1.0 if len(set(ys)) == 1 else _pll_tbl_statistics.correlation(xs, ys) ** 2
    return slope, intercept, r_squared


def _fit_title(slope, intercept, r_squared):
    return "y=%.3fx %s %.3f;     r-sq: %.3f" % (
        slope, "+" if intercept >= 0 else "-", abs(intercept), r_squared,
    )


# -----------------------------------------------------------------------------
# Charts
# -----------------------------------------------------------------------------
#
# A chart is SVG made into an image (`_PllChart`), so it is displayed,
# `beside`d and annotated `-> Image` like any picture. Each is a white box
# with a title (`_chart`), and most have a plotting area (`_plot_box`) with
# an axis (`_axis`) along its bottom and its left, each mapping values onto
# pixels with a `_Scale`.

_CHART_W = 480
_CHART_H = 320
_CHART_MARGIN_L = 56
_CHART_MARGIN_R = 16
_CHART_MARGIN_T = 28  # space for title
_CHART_MARGIN_B = 44

#: Series colours, for labelled groups and pie slices. Ordered so
#: neighbouring series stay distinguishable rather than shading into one
#: another.
_PALETTE = (
    "#4f8cff", "#f2994a", "#27ae60", "#eb5757",
    "#9b51e0", "#2d9cdb", "#f2c94c", "#56ccf2",
)


class _PllChart(_Picture):
    """A chart: an image, which displays and combines like any other."""

    def __init__(self, markup, width, height):
        self._markup = markup
        _Picture.__init__(self, width, height, "image/svg+xml", markup.encode(), "a chart")

    def to_svg(self):
        return self._markup

    def __repr__(self):
        return "<Chart %dx%d>" % (_pll_px(self._w), _pll_px(self._h))


def _plot_box(height=_CHART_H):
    """The plotting area inside a chart `height` high: (x, y, w, h)."""
    return (
        _CHART_MARGIN_L,
        _CHART_MARGIN_T,
        _CHART_W - _CHART_MARGIN_L - _CHART_MARGIN_R,
        height - _CHART_MARGIN_T - _CHART_MARGIN_B,
    )


def _chart(title, body, height=_CHART_H, x_label=None, y_label=None):
    """The chart: a white box with its title, and its axes' names if it has axes."""
    px, py, pw, ph = _plot_box(height)
    words = ""
    if title:
        words += (
            '<text x="%d" y="%d" text-anchor="middle" font-size="13" font-weight="600">%s</text>'
            % (_CHART_W / 2, _CHART_MARGIN_T - 12, _pll_xml_escape(title))
        )
    if x_label is not None:
        words += (
            '<text x="%d" y="%d" text-anchor="middle" font-size="11" font-style="italic">%s</text>'
            '<text x="%d" y="%d" text-anchor="middle" font-size="11" '
            'font-style="italic" transform="rotate(-90 %d %d)">%s</text>'
        ) % (
            px + pw / 2, height - 8, _pll_xml_escape(x_label),
            16, py + ph / 2, 16, py + ph / 2, _pll_xml_escape(y_label),
        )
    markup = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
        'viewBox="0 0 %d %d" font-family="sans-serif" '
        'shape-rendering="geometricPrecision">'
        '<rect x="0" y="0" width="%d" height="%d" fill="white"/>'
        "%s%s</svg>"
    ) % (_CHART_W, height, _CHART_W, height, _CHART_W, height, words, "".join(body))
    return _PllChart(markup, _CHART_W, height)


def _ticks(lo, hi, target):
    """About `target` round-numbered ticks covering `lo` to `hi`, each 1, 2
    or 5 times a power of ten apart."""
    if lo == hi:
        # One value: padded, so there is still an axis to draw.
        lo, hi = (-1.0, 1.0) if lo == 0 else (lo - abs(lo) * 0.5, hi + abs(hi) * 0.5)
    raw = (hi - lo) / target
    mag = 10.0 ** _math.floor(_math.log10(raw))
    step = next(nice for top, nice in ((1.5, 1.0), (3.5, 2.0), (7.5, 5.0), (_math.inf, 10.0)) if raw / mag < top) * mag
    first = _math.floor(lo / step)
    return [(first + i) * step for i in range(_math.ceil(hi / step) - first + 1)]


class _Scale:
    """Values from `lo` to `hi` onto pixels: from `start`, `length` long
    (negative going up the page), with round-numbered ticks along it."""

    def __init__(self, lo, hi, target, start, length):
        self.ticks = _ticks(lo, hi, target)
        self.lo, self.hi = self.ticks[0], self.ticks[-1]
        self.start, self.length = start, length

    def __call__(self, value):
        return self.start + (value - self.lo) / (self.hi - self.lo) * self.length


def _format_tick(v):
    if v == int(v) and abs(v) < 1e16:
        return "%d" % int(v)
    return "%g" % v


def _axis(box, across, marks, lines=True):
    """An axis along the bottom of the plot (`across`) or up its left: each
    of `marks`, a (pixel, label) pair, labelled, and with a light line across
    the plot when `lines`."""
    px, py, pw, ph = box
    grid = []
    words = []
    for at, label in marks:
        if lines:
            grid.append(
                '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#eee"/>'
                % ((at, py, at, py + ph) if across else (px, at, px + pw, at))
            )
        words.append(
            '<text x="%g" y="%g" font-size="10" text-anchor="middle" fill="#444">%s</text>'
            % (at, py + ph + 14, _pll_xml_escape(label))
            if across
            else '<text x="%g" y="%g" font-size="10" text-anchor="end" fill="#444" '
            'dominant-baseline="middle">%s</text>' % (px - 6, at, _pll_xml_escape(label))
        )
    return '<g stroke="#bbb" stroke-width="1" fill="none">%s<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#888"/></g>%s' % (
        "".join(grid),
        *((px, py + ph, px + pw, py + ph) if across else (px, py, px, py + ph)),
        "".join(words),
    )


def _numbered(scale):
    """A scale's ticks as an axis's marks."""
    return [(scale(t), _format_tick(t)) for t in scale.ticks]


def _label_colours(labels):
    """A colour for each label, in the order they first appear, so the key
    reads in the same order as the table."""
    colors = {}
    for label in labels:
        if label not in colors:
            colors[label] = _PALETTE[len(colors) % len(_PALETTE)]
    return colors


def _legend(entries, y, x=None):
    """A colour key, on a white panel so it stays readable over the data.

    At `x`, or else at the plot's right - where above eight entries it is
    left out: a wall of text, while the colours still tell the groups apart.
    """
    width = 24.0 + max(len(str(label)) for _, label in entries) * 6.2
    if x is None:
        if len(entries) > 8:
            return ""
        px, _, pw, _ = _plot_box()
        x = px + pw - width - 4
    rows = [
        '<rect x="%g" y="%g" width="%g" height="%g" fill="white" '
        'fill-opacity="0.85" stroke="#ddd"/>' % (x, y, width, 6 + len(entries) * 14)
    ]
    for i, (color, label) in enumerate(entries):
        cy = y + 10 + i * 14
        rows.append('<rect x="%g" y="%g" width="8" height="8" fill="%s"/>' % (x + 5, cy - 6, color))
        rows.append(
            '<text x="%g" y="%g" font-size="10" fill="#333">%s</text>'
            % (x + 18, cy + 1, _pll_xml_escape(label))
        )
    return "".join(rows)


def _bar_chart(labels, values, x_label, y_label, title):
    box = px, py, pw, ph = _plot_box()
    lo = min(0.0, min(values))
    hi = max(values)
    y = _Scale(lo, hi if hi != lo else lo + 1.0, 5, py + ph, -ph)
    slot = pw / len(values)
    centres = [px + slot * (i + 0.5) for i in range(len(values))]
    body = [_axis(box, False, _numbered(y)), _axis(box, True, zip(centres, labels), lines=False)]
    bar_w = slot * 0.7
    for cx, v in zip(centres, values):
        y0, yv = y(0), y(v)
        body.append(
            '<rect x="%g" y="%g" width="%g" height="%g" fill="#4f8cff" />'
            % (cx - bar_w / 2, min(y0, yv), bar_w, abs(y0 - yv))
        )
    return _chart(title, body, x_label=x_label, y_label=y_label)


def _xy_chart(xs, ys, x_label, y_label, title, mode, labels=None, lines=(), markers=True, starts=(0,)):
    """Points, joined by a line or coloured by label, and any fitted lines.

    `starts` are the points a line starts afresh at, after a gap.
    """
    box = px, py, pw, ph = _plot_box()
    # A fitted line can reach past the points, so the axes have to cover it
    # too or it would be clipped at the edge of the box.
    all_x = list(xs) + [x for line in lines for x in line[0]]
    all_y = list(ys) + [y for line in lines for y in line[1]]
    sx = _Scale(min(all_x), max(all_x), 6, px, pw)
    sy = _Scale(min(all_y), max(all_y), 5, py + ph, -ph)
    body = [_axis(box, False, _numbered(sy)), _axis(box, True, _numbered(sx))]
    points = [(sx(x), sy(y)) for x, y in zip(xs, ys)]
    if mode == "line":
        lifted = set(starts) | {0}
        body.append(
            '<path d="%s" fill="none" stroke="#4f8cff" stroke-width="2" '
            'stroke-linejoin="round" stroke-linecap="round"/>'
            % " ".join("%s %g %g" % ("M" if i in lifted else "L", a, b) for i, (a, b) in enumerate(points))
        )
        if markers:
            body.extend('<circle cx="%g" cy="%g" r="2.5" fill="#4f8cff"/>' % p for p in points)
    elif labels is None:
        body.extend('<circle cx="%g" cy="%g" r="3" fill="#4f8cff" opacity="0.7"/>' % p for p in points)
    else:
        colors = _label_colours(labels)
        for (a, b), label in zip(points, labels):
            body.append('<circle cx="%g" cy="%g" r="3.5" fill="%s" opacity="0.85"/>' % (a, b, colors[label]))
        body.append(_legend([(c, label) for label, c in colors.items()], py + 4))
    for line_xs, line_ys in lines:
        body.append(
            '<path d="%s" fill="none" stroke="#eb5757" stroke-width="2"/>'
            % ("M " + " L ".join("%g %g" % (sx(x), sy(y)) for x, y in zip(line_xs, line_ys)))
        )
    return _chart(title, body, x_label=x_label, y_label=y_label)


def _pie_chart(labels, values, title, column):
    """Slices plus a key, with each slice's share of the total."""
    total = sum(values)
    if total <= 0:
        raise ValueError(
            "a pie chart needs the values in column %s to add up to more than "
            "zero, but they add up to %s." % (_pll_literal(column), _pll_number(total))
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
        color = _PALETTE[i % len(_PALETTE)]
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
    body.append(_legend(legend, _CHART_MARGIN_T + 4, _CHART_W * 0.62))
    return _chart(title, body)


#: A box plot has one row of data, so it gets a strip like the dot plot
#: rather than a square with the box stranded in the middle of it.
_BOX_PLOT_H = _CHART_MARGIN_T + 96 + _CHART_MARGIN_B


def _box_plot(values, name, title):
    """A box from the quartiles, whiskers to 1.5*IQR, outliers as points.

    Quartiles as `statistics.quantiles(..., method="inclusive")` and numpy's
    default percentile give them, so a student can check the box by hand.
    """
    box = px, py, pw, ph = _plot_box(_BOX_PLOT_H)
    q1, median, q3 = _pll_tbl_statistics.quantiles(values, n=4, method="inclusive")
    iqr = q3 - q1
    inside = [v for v in values if q1 - 1.5 * iqr <= v <= q3 + 1.5 * iqr] or values
    low, high = min(inside), max(inside)
    x = _Scale(min(values), max(values), 6, px, pw)
    mid = py + ph * 0.58
    half = ph * 0.26
    body = [
        _axis(box, True, _numbered(x)),
        '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#444"/>' % (x(low), mid, x(high), mid),
    ]
    for v in (low, high):
        body.append(
            '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#444"/>'
            % (x(v), mid - half * 0.5, x(v), mid + half * 0.5)
        )
    body.append(
        '<rect x="%g" y="%g" width="%g" height="%g" fill="#4f8cff" '
        'fill-opacity="0.35" stroke="#4f8cff"/>'
        % (x(q1), mid - half, max(x(q3) - x(q1), 1.0), half * 2)
    )
    body.append(
        '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="#1b4fa0" stroke-width="2"/>'
        % (x(median), mid - half, x(median), mid + half)
    )
    for v in values:
        if v < low or v > high:
            body.append('<circle cx="%g" cy="%g" r="3" fill="none" stroke="#eb5757"/>' % (x(v), mid))
    summary = "min %s  q1 %s  median %s  q3 %s  max %s" % tuple(
        _format_tick(v) for v in (low, q1, median, q3, high)
    )
    body.append(
        '<text x="%g" y="%g" font-size="10" fill="#555" text-anchor="middle">%s</text>'
        % (px + pw / 2, py + 10, _pll_xml_escape(summary))
    )
    return _chart(title, body, _BOX_PLOT_H, name, "")


_DOT_RADIUS = 5.0


def _dot_plot(values, labels, name, title):
    """One dot per row, stacked where rows share a value.

    Sized to the tallest stack, and with no y-axis: stacking says "two rows
    had this value", which is not a quantity to put a scale against.
    """
    tally = {}
    for v in values:
        tally[v] = tally.get(v, 0) + 1
    stack_h = max(tally.values()) * (_DOT_RADIUS * 2 + 1) + _DOT_RADIUS
    colors = _label_colours(labels) if labels is not None else {}
    # The key sits inside the plot area, so the strip has to be tall enough
    # to hold it, or a tall stack at the right-hand end draws through it.
    legend_h = (6 + len(colors) * 14 + 8) if 0 < len(colors) <= 8 else 0
    chart_h = _CHART_MARGIN_T + max(64.0, stack_h + 10, legend_h + stack_h) + _CHART_MARGIN_B
    box = px, py, pw, ph = _plot_box(chart_h)
    x = _Scale(min(values), max(values), 6, px, pw)
    body = [_axis(box, True, _numbered(x))]
    seen = {}
    for i, v in enumerate(values):
        level = seen.get(v, 0)
        seen[v] = level + 1
        body.append(
            '<circle cx="%g" cy="%g" r="%g" fill="%s" opacity="0.85"/>'
            % (
                x(v),
                py + ph - _DOT_RADIUS - level * (_DOT_RADIUS * 2 + 1),
                _DOT_RADIUS,
                colors[labels[i]] if labels is not None else "#4f8cff",
            )
        )
    if colors:
        body.append(_legend([(c, label) for label, c in colors.items()], py + 2))
    return _chart(title, body, chart_h, name, "")


def _histogram(values, bins, name, title, bin_width=None):
    """Counts per bucket: `bins` of them across the values, or buckets
    `bin_width` wide starting at a multiple of it, so ages grouped by 5
    are 20-25, 25-30, ...
    """
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
    if bins > 1000:
        raise ValueError(
            "histogram would draw %d bars, and at most 1000 fit: %s."
            % (bins, "use a wider bin_width" if bin_width is not None else "ask for fewer bins")
        )
    counts = [0] * bins
    for v in values:
        counts[min(int((v - lo) / width), bins - 1)] += 1
    box = px, py, pw, ph = _plot_box()
    y = _Scale(0, max(counts), 5, py + ph, -ph)
    x = _Scale(lo, hi, 6, px, pw)
    body = [_axis(box, False, _numbered(y)), _axis(box, True, _numbered(x))]
    for i, c in enumerate(counts):
        left, right = x(lo + i * width), x(lo + i * width + width)
        # Inset slightly so bars don't touch.
        body.append(
            '<rect x="%g" y="%g" width="%g" height="%g" fill="#4f8cff" opacity="0.85"/>'
            % (left + 0.5, y(c), max(1.0, right - left - 1), y.start - y(c))
        )
    return _chart(title, body, x_label=name, y_label="count")


#: The names the install step copies into the student's globals.
PLL_TABLE_EXPORTS = "Table Row table table_from_columns load_table function_plot".split()

# Each function says it is `pll.table`'s, so `help(load_table)` does.
for _pll_exported in PLL_TABLE_EXPORTS:
    _pll_value = globals()[_pll_exported]
    if callable(_pll_value) and not isinstance(_pll_value, type):
        _pll_value.__module__ = "pll.table"
del _pll_exported, _pll_value
