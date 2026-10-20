# Errors about names and syntax: a name Python does not know, or does not
# have a value for yet, and a line it cannot read.

#: What a student has to write to get a name an import provides. `pd` is
#: the one that matters most: Python's own suggestion for it is `id`, a
#: real built-in and nothing to do with pandas.
_PLL_IMPORT_FOR = {
    "dataclass": "from dataclasses import dataclass",
    "field": "from dataclasses import field",
    "pd": "import pandas as pd",
    "pandas": "import pandas",
    "np": "import numpy as np",
    "numpy": "import numpy",
    "math": "import math",
    "pytest": "import pytest",
    "statistics": "import statistics",
    "random": "import random",
    "Callable": "from typing import Callable",
    "Optional": "from typing import Optional",
    "Any": "from typing import Any",
    "datetime": "import datetime",
    "json": "import json",
    "csv": "import csv",
    "re": "import re",
}

#: Python's keywords, which a student may reach for as a variable name.
_PLL_KEYWORDS = frozenset(
    "False None True and as assert async await break class continue def del elif else except finally for from"
    " global if import in is lambda nonlocal not or pass raise return try while with yield".split()
)


@_pll_explains("SyntaxError", "IndentationError", "TabError")
def _pll_explain_syntax(e):
    """Better wording for the syntax errors students actually hit.

    Python's own message is kept whenever it is already clear (`expected
    ':'`, `'(' was never closed`). These are the ones where it is not: it
    names the token that finally failed to parse rather than the mistake,
    so `else if` becomes "expected ':'" and `class = 30` becomes "invalid
    syntax" pointing at the `=`. The student's line is what makes them
    recognisable: Python has already forgotten what the construct was.
    """
    run = getattr(e, "run", None)
    source = run[1] if run and e.file == run[0] else None
    headline, how_to_fix = _pll_syntax_wording(e.type, e.message, e.text, source, e.line)
    return {"id": "syntax-error", "headline": headline, "howToFix": how_to_fix, "nameToken": None}


def _pll_syntax_wording(error_type, message, line, source=None, line_number=None):
    """`(headline, how_to_fix)` for a syntax error on `line`: the first
    rewording that fits. `source` is the program, when there is one, and
    `line_number` where in it the line is."""
    line = (line or "").strip()
    if error_type == "TabError":
        return "This line mixes tabs and spaces for its indentation.", [
            "Use spaces throughout. In VS Code, the command **Convert Indentation to Spaces** fixes the whole file.",
            "A tab and four spaces look identical on screen, which is why this is hard to see.",
        ]
    bad = _pll_src_re.search(r"invalid character '(.)' \(U\+[0-9A-F]+\)", message)
    if bad:
        if bad.group(1) in "“”‘’":
            return "`%s` is not a character Python can read here." % bad.group(1), [
                'Use straight quotes (`"` and `\'`) rather than curly ones.',
                "Curly quotes come from copying out of a document or a web page; retyping the quotes fixes it.",
            ]
        return "`%s` is not a character Python can read here." % bad.group(1), [
            "Retype the line; the character may have come from copying out of a document."
        ]
    definition = _pll_definition_mistake(line, source, line_number)
    if definition is not None:
        return definition
    # `else if` parses as `else` followed by an expression, so Python asks
    # for the colon it wanted after `else`.
    if _pll_src_re.match(r"else\s+if\b", line):
        return "Python spells this `elif`, not `else if`.", ["Write `elif` as one word, then the condition and a colon."]
    if "'return' outside function" in message:
        return "`return` only works inside a function.", [
            "To show a value at the top level of a file, use `print(...)` or write the value on a line of its own.",
            "If this was meant to be inside a function, check that it is indented under the `def`.",
        ]
    compare = ["`==` asks whether two values are equal; `=` gives a name a value."]
    # Python suggests `==` *or* `:=`. The walrus is not something a student
    # in this course has met, and offering it invites a second mistake.
    if "Maybe you meant '=='" in message:
        if _pll_src_re.match(r"assert\b", line):
            return "A test compares with `==`, not `=`.", compare
        return "This compares two values, so it needs `==`.", compare
    # `assert f(x) = 0` does not reach the suggestion above - the left side
    # is a call, which cannot be assigned to at all, so Python just gives up.
    if _pll_src_re.match(r"assert\b", line) and _pll_src_re.search(r"(^|[^=!<>])=([^=]|$)", line):
        return "A test compares with `==`, not `=`.", compare
    # `case Boa:` parses, and only fails when compiled. Python's message is
    # about the consequence - the cases below can never run - rather than
    # the cause, which is the missing brackets.
    capture = _pll_src_re.search(r"name capture '(\w+)' makes remaining patterns unreachable", message)
    if capture:
        name = capture.group(1)
        return "`case %s:` needs brackets: `case %s():`." % (name, name), [
            "Without them, `%s` is a new name that matches anything, so no `case` after it can ever run." % name,
            "With them, `case %s():` matches only %s; put one name inside for each field." % (name, _pll_a("`%s`" % name)),
        ]
    assigned = _pll_src_re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=[^=]", line)
    if assigned and assigned.group(1) in _PLL_KEYWORDS:
        keyword = assigned.group(1)
        return "`%s` is a word Python reserves, so it cannot be a name." % keyword, [
            "Pick another name, such as `%s_value` or something describing what it holds." % keyword
        ]
    return (_pll_punctuated(message) if message.strip() else "Python could not read this line."), []


#: A line that starts a function the way another language does, or with
#: no name: `def`, or Pyret's `fun`; a name, which may have Pyret's `-` in
#: it; and the brackets, and the rest of the line as written.
_PLL_DEFINITION_LINE = _pll_src_re.compile(
    r"(?P<keyword>async\s+def|def|fun)\b\s*(?P<name>[A-Za-z_]\w*(?:-\w+)*)?(?P<rest>\s*\(.*)$"
)


def _pll_definition_mistake(line, source=None, line_number=None):
    """`def foo-bar(x):`, `def (x):` and Pyret's `fun foo(x):`, said as
    what they are - but only a line that is exactly one of those: mended as
    said, it has to parse, with the rest of the program around it when there
    is one. Anything else wrong with it, and nothing here is said."""
    found = _PLL_DEFINITION_LINE.match(line)
    if found is None:
        return None
    keyword, name, rest = found.group("keyword"), found.group("name"), found.group("rest")
    pyret = keyword == "fun"
    hyphens = name is not None and "-" in name
    if (pyret and name is None) or (not pyret and name is not None and not hyphens):
        return None
    mended = (name or "function_name").replace("-", "_")
    written = ("async def" if keyword.startswith("async") else "def") + " " + mended + rest
    if not _pll_parses_mended(line, written, source, line_number):
        return None
    call = "`%s(...)`" % mended
    if pyret:
        headline = "Python defines a function with `def`, not `fun`%s." % (
            " - and a name cannot have a `-` in it" if hyphens else ""
        )
        how_to_fix = ["Write `def %s(...)`%s." % (mended, ", and call it %s too" % call if hyphens else "")]
        end = _pll_pyret_end(source, line_number)
        if end is not None:
            how_to_fix.append(
                "Take out the `end` on line %d too: a Python function ends where its indented lines do." % end
            )
        return headline, how_to_fix
    if name is None:
        return "This `def` has no name.", [
            "Put one between `def` and the brackets - `def %s(...)` - with a name that says what it does." % mended
        ]
    return "A function's name cannot have a `-` in it: Python reads `%s` as `%s`." % (
        name, "` minus `".join(name.split("-"))
    ), [
        "Write `def %s(...)`, with %s, and call it %s too."
        % (mended, "an underscore" if name.count("-") == 1 else "underscores", call)
    ]


def _pll_parses_mended(line, written, source, line_number):
    """Whether `line`, written as `written`, parses: in `source`, at
    `line_number`, when there is a program - a later line failing is
    another mistake, not this one - or else on its own, as a whole
    definition."""
    if source is not None and line_number:
        lines = source.split("\n")
        if not 0 < line_number <= len(lines) or lines[line_number - 1].strip() != line:
            return False
        old = lines[line_number - 1]
        lines[line_number - 1] = old[: len(old) - len(old.lstrip())] + written + ("\r" if old.endswith("\r") else "")
        try:
            _ast.parse("\n".join(lines))
        except SyntaxError as err:
            return err.lineno is not None and err.lineno > line_number
        return True
    for attempt in (written, written + "\n    pass"):
        try:
            _ast.parse(attempt)
            return True
        except SyntaxError:
            continue
    return False


def _pll_pyret_end(source, line_number):
    """The first line after `line_number` that is only `end`, as a Pyret
    function is closed with, or None."""
    if source is None or not line_number:
        return None
    for number, text in enumerate(source.split("\n")[line_number:], start=line_number + 1):
        if text.strip() == "end":
            return number
    return None


@_pll_explains("NameError", "UnboundLocalError")
def _pll_explain_name(e):
    """A name Python does not know - or, `UnboundLocalError`, the same
    mistake to a student: a name used before it has a value.

    The message is the one Python shows - `name 'Totl' is not defined. Did
    you mean: 'total'?` - so its suggestion is in it, and becomes a "Did
    you mean" line of its own rather than part of the headline.
    """
    headline, how_to_fix = _pll_name_wording(e)
    return "name-error", headline, how_to_fix


def _pll_name_wording(e):
    named = e.name is not None
    name = e.name if named else "this name"
    line = e.text
    # What a check made before the run knows, as facts: where the name lost
    # its value, or that it is the class still being made.
    deleted = e.facts.get("deleted_on")
    if named and deleted is not None:
        return "`%s` was removed by the `del` on line %d, so it has no value here." % (name, deleted), [
            "Use `%s` before the `del`, or leave the `del` out." % name
        ]
    handler = e.facts.get("except_on")
    if named and handler is not None:
        return "`%s` has a value only inside the `except` on line %d: Python removes it when that block ends." % (
            name, handler
        ), ["Use it inside the `except` block, or keep what you need in another name there: `error = %s`." % name]
    if named and e.facts.get("being_defined"):
        headline = "`%s` is the class being defined here, and has no value until the class is finished." % name
        annotated = _pll_annotation_target(line, name)
        if annotated is not None:
            example = _pll_as_string_annotation(line, annotated, name)
            return headline, [
                "Write the type as a string - `%s` - and Python looks it up later, once the class exists." % example
            ]
        return headline, ["Use it inside a method: a method runs later, once the class exists."]
    # Read in a function that a call runs too early: the mistake is the
    # order of that call and the line setting the name, not this line.
    called_on = e.facts.get("called_on")
    if named and called_on is not None:
        path = e.facts.get("called") or ["this function"]
        # "`a` uses it", or "`a` calls `b`, which uses it".
        who = "`%s`" % path[0] + "".join(" calls `%s`, which" % function for function in path[1:])
        headline = "Line %d calls `%s` before `%s` has a value, and %s uses it here." % (called_on, path[0], name, who)
        set_on = e.facts.get("defined_on")
        if set_on is not None:
            return headline, [
                "`%s` gets its value on line %d, after the call." % (name, set_on),
                "Move the call below line %d, or move the line that sets `%s` above line %d."
                % (set_on, name, called_on),
            ]
        return headline, ["Give `%s` a value before line %d, where `%s` is called." % (name, called_on, path[0])]
    # "Never heard of it" and "not assigned yet" need opposite advice: the
    # second is a name spelled correctly, so telling the student to check
    # the spelling sends them looking for a mistake that is not there. What
    # is wrong is the order.
    unbound = _pll_src_re.search(r"cannot access (free|local) variable '", e.message)
    if unbound:
        return "`%s` has not been given a value yet on this line." % name, [
            "Move the line that sets `%s` above this one." % name,
            "If you meant a `%s` from outside this function: assigning to it anywhere inside makes it local to the"
            " whole function, so the outer one is not visible here. Pass it in as a parameter instead." % name
            if unbound.group(1) == "local"
            else "The `%s` here belongs to the function around this one, which sets it after this line runs." % name,
        ]
    pattern = e.facts.get("pattern_class")
    if pattern is not None:
        return _pll_pattern_class_wording(
            name, pattern["subject"], pattern["union"], pattern["members"], pattern["classes"]
        )
    if named and line is not None:
        escaped = _pll_src_re.escape(name)
        # A function's parameter, used where the function itself belonged:
        # `filter(below_1k(r))` calls `below_1k` right there, so `r` has no
        # value - a symptom of passing the result rather than the function.
        for taker in _PLL_FUNCTION_TAKERS:
            passed = _pll_src_re.search(r"\b%s\s*\(\s*([A-Za-z_]\w*)\s*\(\s*%s\s*\)" % (taker, escaped), line)
            if passed:
                fn = passed.group(1)
                return "`%s` calls `%s` for you, so `%s` is not something you write here." % (taker, fn, name), [
                    "Pass the function itself: `%s(%s)`." % (taker, fn),
                    "`%s` supplies the argument for each row, so `%s` is never called by hand." % (taker, fn),
                ]
        # A `-` where a name has `_`: Python reads `load-table(...)` as
        # `load` minus `table(...)`. Only a function's name, called:
        # `total-tax` on its own is as likely a subtraction.
        for found in _pll_src_re.finditer(r"(?<![.\w])([A-Za-z_]\w*(?:-[A-Za-z_]\w*)+)(?=\s*\()", line):
            hyphen = found.group(1)
            if name in hyphen.split("-"):
                return "Python reads `%s` as `%s`: a name cannot have a `-` in it." % (
                    hyphen, "` minus `".join(hyphen.split("-"))
                ), ["Write `%s`, with an underscore." % hyphen.replace("-", "_")]
        # A table's method, called as if it were a function of its own.
        if _pll_table_method(name):
            method = _pll_src_re.search(r"\b%s\s*\(\s*([A-Za-z_][\w.]*)\s*(?:,\s*([^)]*))?\)" % name, line)
            if method:
                return "`%s` is a method of a table, so it is called on one." % name, [
                    "Write `%s.%s(%s)`." % (method.group(1), name, (method.group(2) or "").strip())
                ]
    if named and name in _PLL_IMPORT_FOR:
        return "`%s` comes from an import, and this file has not imported it." % name, [
            "Add `%s` at the top of the file." % _PLL_IMPORT_FOR[name]
        ]
    # Defined, but further down: Python runs the file from the top.
    later = e.facts.get("defined_on")
    if later is None and named:
        later = _pll_defined_later_at(e.source, name, e.info["lineNumber"])
    if later is not None:
        # In an annotation, moving the definition up is not the fix and is
        # often impossible: a recursive type names itself.
        annotated = _pll_annotation_target(line, name)
        if annotated is not None:
            example = _pll_as_string_annotation(line, annotated, name)
            return "`%s` is defined on line %d, after this line, and an annotation is read as the file runs." % (
                name, later
            ), [
                "Write the type as a string - `%s` - and Python looks it up later, once it exists." % example,
                "A type that names itself can only be written that way: the union needs the class, and the class"
                " needs the union.",
            ]
        return "`%s` is defined on line %d, after this line." % (name, later), [
            "Python runs a file from the top, so nothing further down exists yet.",
            "Move the definition of `%s` above this line." % name,
        ]
    # A type by another language's name - `string`, `Number`, `List` - for
    # which Python suggests nothing, or a module to import.
    as_type = named and _pll_read_as_type(e)
    if as_type and name in _PLL_NOT_A_TYPE:
        return "`%s` is not a type Python knows." % name, _pll_type_fix(name)
    headline = "Python doesn't know what `%s` means." % name
    meant = _pll_did_you_mean(e.message)
    # One suggestion is a question, not "one of those". Differing only in
    # case is the whole story, and a confident match makes the spelling and
    # the quotes beside the point.
    if len(meant) == 1:
        if meant[0].lower() == name.lower():
            return headline, [
                "Did you mean `%s`? Python names are case-sensitive, so `%s` and `%s` are different names."
                % (meant[0], name, meant[0])
            ]
        return headline, ["Did you mean `%s`?" % meant[0]]
    how_to_fix = [
        "Check the spelling of `%s` (Python is case-sensitive)." % name,
        "Make sure `%s` is defined before this line runs." % name,
    ]
    if as_type:
        # Quoting a type is a forward reference, not text: it names the
        # same missing thing.
        how_to_fix.append("An annotation names a type: `int`, `float`, `str`, `bool`, `list`, `dict`, or a class of your own.")
    elif named:
        # Only worth saying with a real name to quote: `put "this name" in
        # quotes` is advice about the placeholder rather than about the code.
        how_to_fix.append('If `%s` should be text, put it in quotes: `"%s"`.' % (name, name))
    if len(meant) > 1:
        how_to_fix.insert(0, "Did you mean one of %s?" % ", ".join("`%s`" % m for m in meant))
    return headline, how_to_fix


def _pll_type_fix(written):
    """What to write for `written`, a type by a name Python does not use
    (`_PLL_NOT_A_TYPE`): one line naming the type - a number, either."""
    meant = _PLL_NOT_A_TYPE[written]
    fix = ["Write `%s` instead." % meant]
    if written.lower() == "number":
        fix.append("Or `int`, if it is always a whole number.")
    return fix


def _pll_read_as_type(e):
    """Whether the name `e` is about is read as a type: in an annotation,
    or as a `type` alias's value. A check before the run says so; for a
    run's error it is read off the program, at the error's line and column."""
    if e.facts.get("in_annotation"):
        return True
    run = getattr(e, "run", None)
    line = getattr(e, "line", None)
    if not run or line is None or getattr(e, "file", None) != run[0]:
        return False
    return _pll_annotates(run[1], line, getattr(e, "column", None), e.name)


def _pll_annotates(source, line, column, name):
    """Whether `name`, read on `line` (at `column`, when known) of `source`,
    is in an annotation or a `type` alias's value."""
    try:
        tree = _ast.parse(source)
    except SyntaxError:
        return False
    for node in _ast.walk(tree):
        types = []
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
            args = node.args
            every = args.posonlyargs + args.args + args.kwonlyargs + [a for a in (args.vararg, args.kwarg) if a]
            types = [a.annotation for a in every if a.annotation is not None]
            types += [node.returns] if node.returns is not None else []
        elif isinstance(node, _ast.AnnAssign):
            types = [node.annotation]
        elif isinstance(node, getattr(_ast, "TypeAlias", ())):
            types = [node.value]
        for written in types:
            for read in _ast.walk(written):
                if (
                    isinstance(read, _ast.Name)
                    and read.id == name
                    and read.lineno == line
                    and (column is None or read.col_offset == column)
                ):
                    return True
    return False


def _pll_defined_later_at(source, name, used_on):
    """The line `name` is defined on, when that is after `used_on`. Python
    runs a file from the top, so a name defined further down does not exist
    yet - and "check the spelling" sends the student looking for a mistake
    that is not there."""
    if not source or used_on is None:
        return None
    escaped = _pll_src_re.escape(name)
    defined = _pll_src_re.compile(
        r"[ \t]*(?:def[ \t]+%s[ \t]*\(|class[ \t]+%s\b|%s[ \t]*(?::[^=]+)?=[^=])" % (escaped, escaped, escaped)
    )
    lines = _pll_src_re.split(r"\r?\n", source)
    for i in range(used_on, len(lines)):
        if defined.match(lines[i]):
            return i + 1
    return None


def _pll_annotation_target(line, name):
    """What `name` annotates on this line: a field, variable or parameter's
    name, "" for a return type, or None when it is no annotation.

    `rest: NumList` inside the very class the union is built from cannot be
    fixed by moving anything: `NumList = Empty | Link` needs `Link`, and
    `Link` needs `NumList`. Python's answer is the string form, resolved
    later - the shape of every recursive data definition in the course.
    """
    if line is None:
        return None
    escaped = _pll_src_re.escape(name)
    named = _pll_src_re.match(r"\s*([A-Za-z_]\w*)\s*:\s*%s\b" % escaped, line) or _pll_src_re.search(
        r"[(,]\s*([A-Za-z_]\w*)\s*:\s*%s\b" % escaped, line
    )
    if named:
        return named.group(1)
    return "" if _pll_src_re.search(r"->\s*%s\b" % escaped, line) else None


def _pll_as_string_annotation(line, target, name):
    """`rest: "Link | None"`: the annotation on `line` for `target` ("" for
    a return type), all of it as a string - or, when it cannot be read off
    the line whole, just `name`."""
    if target:
        found = _pll_src_re.search(r"(?:^|[(,])\s*%s\s*:\s*([^=#]+)" % _pll_src_re.escape(target), line)
    else:
        found = _pll_src_re.search(r"->\s*([^#]+?)\s*:\s*(?:#.*)?$", line)
    written = found.group(1).strip() if found else ""
    # A parameter's annotation ends at the next `,` or `)` outside brackets.
    depth = 0
    for i, c in enumerate(written):
        if c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                written = written[:i]
                break
            depth -= 1
        elif c == "," and depth == 0:
            written = written[:i]
            break
    written = written.strip()
    if not written or depth != 0 or name not in written:
        written = name
    return '%s: "%s"' % (target, written) if target else '-> "%s"' % written


def _pll_did_you_mean(message):
    """The names Python suggests in "Did you mean: 'total'?"."""
    found = _pll_src_re.search(r"Did you mean:\s*([^?]+)\??", message, _pll_src_re.I)
    if not found:
        return []
    parts = _pll_src_re.split(r",|\bor\b", found.group(1))
    names = (_pll_src_re.sub(r"^['\"`]|['\"`]$", "", part.strip()) for part in parts)
    return [name for name in names if name]
