# From an exception to a finding: what the student is told about an error,
# and where. `_pll_error_info` (errorInfo.py) describes the exception; the
# rules registered here word it, each for the errors it explains, tried in
# the order they are registered.

#: `(types, explain)` in the order they are tried; see `_pll_explains`.
_PLL_EXPLAINERS = []

#: The errors Python places itself: the position is the error's, not a frame's.
_PLL_PLACED_BY_PYTHON = ("SyntaxError", "IndentationError", "TabError")


def _pll_explains(*types):
    """Register a rule for errors of `types`: a function of the error's
    `_PllError`, giving `(id, headline, how_to_fix)` - or a dict of more of
    the finding's fields - or None to leave the error to the rules after it."""

    def register(explain):
        _PLL_EXPLAINERS.append((types, explain))
        return explain

    return register


class _PllError:
    """An error as the rules read it: what `_pll_error_info` made of it, the
    run it happened in, and where a finding about it goes."""

    def __init__(self, info, run, level):
        self.info = info
        self.type = info["errorType"]
        self.message = info["message"]
        self.facts = info["facts"]
        self.frames = info["frames"]
        self.name = self.facts.get("name")
        self.run = run
        self.level = level
        self.file, self.line, self.column, self.text = self._place()

    def _place(self):
        """Where a finding about the error is: a syntax error where Python
        says it is, and anything else at the innermost frame that runs the
        student's code - in whichever of their files that is.

        With no frame of the student's, the innermost one is PLL's or a
        library's, and its line means nothing in their file, so there is
        no line.
        """
        info = self.info
        run_file = self.run[0] if self.run else None
        if self.type in _PLL_PLACED_BY_PYTHON or not self.frames:
            file = info["fileName"] if info["fileName"] is not None else run_file
            text = info["text"]
            return file, info["lineNumber"], info["column"], text if text is not None else self._line_of_run(
                file, info["lineNumber"]
            )
        frame = self.user_frame
        if frame is None:
            return run_file, None, None, None
        # A caret is about the frame that raised; only there is it theirs.
        column = frame["column"] if frame is self.frames[-1] else None
        return frame["file"], frame["line"], column, self.frame_text(frame)

    @property
    def user_frames(self):
        """The frames running the student's code, outermost first."""
        return [frame for frame in self.frames if frame["user"]]

    @property
    def user_frame(self):
        """The student's own frame that failed - or, when a library raised, called it."""
        frames = self.user_frames
        return frames[-1] if frames else None

    def frame_text(self, frame):
        """The student's line at `frame`: Python's, or the run's own code."""
        if frame is None:
            return None
        return frame["text"] if frame["text"] is not None else self._line_of_run(frame["file"], frame["line"])

    @property
    def in_run_file(self):
        """Whether the finding is in the file that was run."""
        return self.run is not None and self.file == self.run[0]

    @property
    def source(self):
        """The run's code, when the finding is in it, or ""."""
        return self.run[1] if self.in_run_file else ""

    def _line_of_run(self, file, line):
        """A line of the code that was run - a prompt line has no file to
        read back - and only of it: another file's line number means
        nothing here."""
        if self.run is None or file != self.run[0] or not line:
            return None
        lines = _pll_src_re.split(r"\r?\n", self.run[1])
        return lines[line - 1] if 0 < line <= len(lines) else None


def _pll_explain_error(info, run, level):
    """The finding for the error `info` describes: from the first rule that
    explains it, or the catch-all - never None, so no student is shown a
    traceback through PLL's own internals."""
    error = _PllError(info, run, level)
    for types, explain in _PLL_EXPLAINERS:
        if error.type not in types:
            continue
        said = explain(error)
        if said is None:
            continue
        if isinstance(said, tuple):
            said = dict(zip(("id", "headline", "howToFix"), said))
        return _pll_runtime_finding(error, **said)
    return _pll_catch_all(error)


def _pll_catch_all(e):
    """The last resort: any error as a finding.

    It says nothing new. It puts the error in the student's own code and
    Python's message where they will read it, rather than at the end of a
    traceback through PLL's machinery or dozens of lines of pandas - the
    message a student needs is usually already clear (`No column named
    'rider' (have: month, riders)`). Rules that know an error well win.
    """
    # A table's rows are read from the source of the file that was run.
    row = _pll_row_line(e.source, e.line, e.message) if e.in_run_file else None
    return _pll_runtime_finding(
        e,
        id="runtime-error",
        headline=_pll_headline_for(e),
        # Deliberately empty. A generic error has no generic remedy, and
        # inventing one would be worse than the message itself.
        howToFix=[],
        lineNumber=row if row is not None else e.line,
    )


def _pll_headline_for(e):
    """The message as a sentence a student can read - or, a message the
    student raised themselves, as they wrote it."""
    text = e.message.strip()
    # A Stop, which the student asked for: not something their code did
    # wrong. A `KeyboardInterrupt` the program raised itself is its error.
    if e.type == "KeyboardInterrupt" and e.facts.get("stop") is True:
        return "The program was stopped."
    if not text:
        return "%s while running your program." % e.type
    innermost = e.frames[-1] if e.frames else None
    theirs = bool(innermost and innermost["user"] and _pll_src_re.match(r"\s*raise\b", innermost["text"] or ""))
    finish = (lambda sentence: sentence) if theirs else _pll_punctuated
    if e.type == "KeyError":
        # `str(KeyError(x))` is the *repr* of x, so a message written as a
        # sentence arrives wrapped in quotes: unwrap that one. A plain
        # missing key arrives the same way (`'rider'`) but is not a
        # sentence, and is left exactly as Python wrote it.
        unquoted = _pll_src_re.fullmatch(r"'([\s\S]*)'", text) or _pll_src_re.fullmatch(r'"([\s\S]*)"', text)
        if unquoted is None or not _pll_src_re.search(r"\s", unquoted.group(1)):
            return text
        return finish(unquoted.group(1))
    return finish(text)


def _pll_row_line(source, call_line, message):
    """The line of the row a `table(...)` error is about, when it can be found.

    The error is raised inside the library, so the student's innermost
    frame is the `table(` line. The message names the row by position ("the
    2nd row, ..."), and for rows written out in place that row has a line
    of its own - the one worth pointing at. Rows passed as a variable have
    none, and the `table(` line is kept.
    """
    ordinal = _pll_src_re.search(r"\bthe (\d+)(?:st|nd|rd|th) row\b", message)
    if call_line is None or ordinal is None:
        return None
    index = int(ordinal.group(1)) - 1
    lines = _pll_src_re.split(r"\r?\n", source)
    if not 1 <= call_line <= len(lines):
        return None
    call = _pll_src_re.search(r"\b(?:table|Table)\s*\(", lines[call_line - 1])
    if call is None:
        return None
    text = "\n".join(lines)
    # Walk the call's brackets from just after `table(`, skipping strings
    # and comments, so a `,` or `]` inside one does not count.
    i = sum(len(line) + 1 for line in lines[: call_line - 1]) + call.end()
    depth, argument, row, rows_open, awaiting_row = 1, 0, -1, False, False
    while i < len(text) and depth > 0:
        c = text[i]
        if c in "\"'":
            quote = c * 3 if text.startswith(c * 3, i) else c
            i += len(quote)
            while i < len(text) and not text.startswith(quote, i):
                i += 2 if text[i] == "\\" else 1
            i += len(quote)
            continue
        if c == "#":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        if c.isspace():
            i += 1
            continue
        # The first character of a row: where it starts.
        if awaiting_row and c != "]":
            row += 1
            if row == index:
                return text.count("\n", 0, i) + 1
            awaiting_row = False
        if c in "([{":
            depth += 1
            if depth == 2 and argument == 1 and c == "[" and not rows_open:
                rows_open = awaiting_row = True
        elif c in ")]}":
            depth -= 1
            if rows_open and depth == 1:
                # The rows list closed without reaching the row.
                return None
        elif c == ",":
            if depth == 1:
                argument += 1
                if argument > 1:
                    return None
            elif depth == 2 and rows_open:
                awaiting_row = True
        elif depth == 1 and argument == 1 and not rows_open:
            # The rows argument is not a list written out here.
            return None
        i += 1
    return None


@_pll_explains("ChecksFailed")
def _pll_explain_checks_failed(e):
    """One of the student's files that another imports, refused because it
    did not pass its own level's checks (`imports.py`). Reported at the
    `import`, which is where the program stopped, with each problem in the
    file worded as a run of that file words it."""
    checks = e.facts.get("checks")
    if checks is None:
        return None
    file, problem = checks["file"], checks["header_problem"]
    if problem is not None:
        problems = ["Line %s: %s" % (problem["line"], problem["message"])]
        headline = "`%s` was not imported: there is a problem with its `#level` line." % file
    else:
        problems = ["Line %s: %s" % (f["lineNumber"], f["headline"]) for f in checks["findings"]]
        count = "a problem" if len(problems) == 1 else "%d problems" % len(problems)
        headline = "`%s` was not imported: the checks of `#level %s` found %s in it." % (file, checks["level"], count)
    return {
        "id": "checks-failed",
        "errorType": "ChecksFailed",
        "headline": headline,
        "howToFix": problems + ["Run `%s` itself to see %s where it is." % (file, "it" if len(problems) == 1 else "each one")],
    }


def _pll_unexplained(info, run):
    """A finding in Python's own words, where the error is: for an error
    whose explanation failed."""
    message = info["message"].strip()
    return {
        "id": "runtime-error",
        "errorType": info["errorType"],
        "headline": message or "%s while running your program." % info["errorType"],
        "howToFix": [],
        "fileName": info["fileName"] if info["fileName"] is not None else (run[0] if run else None),
        "lineNumber": info["lineNumber"],
        "column": info["column"],
        "nameToken": info["facts"].get("name"),
        "severity": "error",
        "origin": "runtime",
    }


def _pll_runtime_finding(error, **fields):
    """A runtime finding about `error`, given what it says differently from
    the error: what Python called it, and where it is, are the error's own."""
    finding = {
        "errorType": error.type,
        "fileName": error.file,
        "lineNumber": error.line,
        "column": error.column,
        "nameToken": error.name,
        "severity": "error",
        "origin": "runtime",
    }
    finding.update(fields)
    return finding


def _pll_punctuated(text):
    """The text as a sentence: trimmed, and ending in a full stop if it had none."""
    trimmed = text.strip()
    return trimmed if trimmed.endswith((".", "!", "?")) else trimmed + "."


# What the explanations know about PLL's own library that its definitions
# do not say: the functions that call one of the student's, what each
# passes it, and what to add to an arity error about one.

#: The library functions that call a function the student passes them, and
#: what they call it with. `each` and `param` are for the table methods,
#: whose function decides about one row or value at a time. The distinction
#: that matters is `transform_column`, which passes one *value* from a
#: column, against `filter` and `add_column`, which pass a whole row.
_PLL_FUNCTION_TAKERS = {
    "filter": {
        "calls": "`filter` calls your function with one row at a time",
        "each": "each row",
        "param": "r: dict",
        "keeps": "keeps the rows where it returns `True`",
    },
    "transform_column": {
        "calls": "`transform_column` calls your function with one *value* from the column, not a row",
        "each": "each value in the column",
        "param": "v",
        "keeps": "puts what it returns in place of the value",
    },
    "add_column": {
        "calls": "`add_column` calls your function with one row at a time",
        "each": "each row",
        "param": "r: dict",
        "keeps": "puts what it returns in the new column",
    },
    "animate": {"calls": "`animate` calls your function with the tick count, a number"},
    "big_bang": {"calls": "`big_bang` calls your handlers with the state"},
}

#: A reactor's handlers, which are given a function by keyword: `to_draw=draw`.
_PLL_HANDLER_KEYWORDS = ("to_draw", "on_tick", "stop_when", "on_key", "on_mouse", "on_receive")

#: Extra lines for an arity error on a library function, where knowing the
#: parameter names is not enough. `table` is the one that matters: the shape
#: of its two arguments - names first, then every row inside one more list -
#: is what goes wrong, and "takes 2 arguments" does not say it.
_PLL_LIBRARY_HINTS = {
    "table": [
        'The column names come first, as a list of strings, then all the rows inside one more list:'
        ' `table(["month", "riders"], [["Jan", 1], ["Feb", 2]])`.'
    ],
    "table_from_columns": [
        '`table_from_columns` takes one dictionary: `table_from_columns({"month": [...], "riders": [...]})`.'
    ],
}

#: The methods of a table, which are called on one: `people.order_by(...)`.
_PLL_TABLE_METHODS = (
    "columns", "length", "column", "row", "rows", "filter", "transform_column", "add_column", "add_row",
    "select_columns", "order_by", "head", "tail", "sum", "mean", "min", "max", "count", "bar_chart",
    "scatter_chart", "scatter_plot", "line_chart", "histogram", "labeled_scatter_plot", "pie_chart", "dot_plot",
    "labeled_dot_plot", "freq_bar_chart", "box_plot", "lr_plot", "labeled_lr_plot", "linear_regression",
    "to_pandas",
)


def _pll_library_caller(frames):
    """The library function that called the student's function, if one did -
    "reactor" for any frame in the reactor library, whichever of its methods
    was driving. Its frames are PLL's, not the student's, but knowing which
    one it was changes the advice completely."""
    for frame in frames:
        if frame["file"] == "<pll:reactor>":
            return "reactor"
        if frame["file"] in ("<pll:table>", "<pll:image>") and frame["function"] in _PLL_FUNCTION_TAKERS:
            return frame["function"]
    return None


#: Plain-language words for the types a beginner course uses, without an
#: article: the one table every explanation uses, so no two of them can name
#: a type differently.
_PLL_TYPE_WORDS = {
    "int": "whole number",
    "float": "number",
    "complex": "complex number",
    "str": "string",
    "bool": "`True` or `False`",
    "bytes": "bytes",
    "list": "list",
    "dict": "dictionary",
    "set": "set",
    "tuple": "tuple",
    "range": "range",
    "function": "function",
    "None": "`None`",
    "NoneType": "`None`",
}


def _pll_type_words(type_name, article=False):
    """The words for a type: "whole number" - or, with `article`, "a whole
    number". None for a type with no plain name, such as a class the
    student wrote. Phrases that are not a noun ("`True` or `False`",
    "bytes") never take an article."""
    words = _PLL_TYPE_WORDS.get(type_name)
    if words is None or not article or words.startswith("`") or words == "bytes":
        return words
    return "a " + words


def _pll_plural(count, noun):
    """"1 argument", "2 arguments"."""
    return "%d %s%s" % (count, noun, "" if count == 1 else "s")
