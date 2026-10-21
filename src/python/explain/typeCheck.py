# A broken contract (bootstrap/contracts.py), as the student is told it:
# from the facts the contract raised with (`check`), which say what the
# annotation is on, what failed and who is to blame - so nothing here reads
# a message back. The first-order cases read as type errors always have;
# the higher-order ones say who broke which promise.

#: The module prefix a student did not write: a file - and its tests - run
#: as `__main__`, so its classes arrive as `__main__.Dog`.
_PLL_MAIN_PREFIX = "__main__."

#: Names PLL's own classes report as, where the course calls them something
#: else. A table row *is* a dict - `Row` subclasses it so a row still
#: compares equal to the plain dict a test is written with - and `dict` is
#: the type the course gives for a row. PLL's picture classes arrive already
#: named `Image` (`_pll_course_type_name`).
_PLL_COURSE_NAME_FOR = {"Row": "dict"}

#: The methods that change a value in place and give back `None`, so that
#: `result = result.append(w)` leaves `result` as `None` - and the error then
#: appears at the `return` two lines later with nothing to connect them.
_PLL_RETURNS_NONE = ("append", "extend", "insert", "remove", "sort", "reverse", "clear", "add", "discard", "update")


@_pll_explains("TypeMismatch")
def _pll_explain_type_check(e):
    check = e.facts.get("check")
    file, line = _pll_contract_place(e, check or {})
    headline, how_to_fix = _pll_type_check_wording(e, check, line)
    return {
        "id": "type-check",
        "errorType": "TypeMismatch",
        "headline": headline,
        "howToFix": how_to_fix,
        "fileName": file,
        "lineNumber": line,
        "column": None,
        "nameToken": check.get("name") if check else None,
    }


def _pll_contract_place(e, check):
    """Where the finding goes: where the party to blame broke the contract.

    - The function's own result: at the `return` that gave it - or, for one
      that ran off its end, at its `def`.
    - Code that gave a bad value where it called: there.
    - Code that handed a function over to be called badly, elsewhere: where
      it handed it over, which is the reference that made the obligation.
    """
    blamed = check.get("blamed") or {}
    applied = check.get("applied")
    site = check.get("site")
    if check.get("role") == "owner" and check.get("kind") == "return":
        line = check.get("returned_at") or blamed.get("line")
        if line is not None:
            return blamed.get("file"), line
    if applied and applied.get("by_blamed"):
        return applied["file"], applied["line"]
    if site and site.get("line") is not None:
        return site["file"], site["line"]
    if applied:
        return applied["file"], applied["line"]
    return (e.run[0] if e.run else None), e.info["lineNumber"]


class _PllCheck:
    """What every kind of explanation is built from: the check, and the
    phrases worked out from it once."""

    def __init__(self, e, check, line):
        check = dict(check or {"kind": "unknown", "name": None, "element": None, "actual": None, "expected": []})
        if check.get("element") is not None:
            check["element"] = _pll_describe_element(check["element"])
        self.e = e
        self.check = check
        self.kind = check.get("kind")
        self.name = check.get("name")
        self.element = check.get("element")
        self.actual = check.get("actual")
        self.expected = check.get("expected") or []
        # The line the finding is on: for a result, the `return` itself - or,
        # when the function ran off its end, its `def`.
        self.line = _pll_line_text(e, line)
        self.called_by = _pll_library_caller(e.frames)
        function = check.get("function")
        self.wanted = _pll_describe_types(self.expected)
        self.owner = "`%s`" % function if function else "this function"
        self.named = "`%s`" % self.name if self.name else "a value"
        self.convert = _pll_conversion_for(self.expected, self.actual)
        self.bool_note = _pll_bool_as_number_note(self.expected, self.actual)
        self.annotation = _pll_clean_type_name(self.expected[0]) if len(self.expected) == 1 else None


def _pll_line_text(e, line):
    """The text of `line` in the run's file, if that is where it is."""
    return e._line_of_run(e.run[0], line) if e.run and line else None


def _pll_type_check_wording(e, check, line):
    c = _PllCheck(e, check, line)
    if c.check.get("higher_order"):
        said = _pll_tc_higher_order(c)
        if said is not None:
            return said
    said = _pll_class_given(c)
    if said is not None:
        return said
    said = _pll_handed_over(c)
    if said is not None:
        return said
    explain = {
        "argument": _pll_tc_argument,
        "field": _pll_tc_field,
        "return": _pll_tc_return,
        "variable": _pll_tc_variable,
    }.get(c.kind, _pll_tc_unfamiliar)
    return explain(c)


def _pll_handed_over(c):
    """A function's own argument contract, broken by a call that code which
    is not to blame made: `add1` handed to `foo`, which calls it with a
    string, is the fault of the line that handed `add1` over - which is
    where the finding is, and what to change."""
    applied, site = c.check.get("applied"), c.check.get("site")
    if c.kind != "argument" or c.element or not applied or applied.get("by_blamed") or not site:
        return None
    caller = "`%s`" % applied["function"] if applied.get("function") else "the top level"
    got = _pll_describe_type(c.actual) if c.actual else "something else"
    how_to_fix = [
        "On line %s, hand over a function that takes %s, which is what %s calls it with." % (site["line"], got, caller),
    ]
    if c.annotation and c.actual:
        how_to_fix.append(
            "Or, if %s should take %s, change its annotation for %s from `%s` to `%s`."
            % (c.owner, got, c.named, c.annotation, _pll_clean_type_name(c.actual))
        )
    return "%s expects %s to be %s, but it was handed over on line %s and then called by %s with %s." % (
        c.owner, c.named, c.wanted, site["line"], caller, got
    ), how_to_fix


def _pll_tc_higher_order(c):
    """A function's contract, broken through a function it takes or gives
    back - which of the four depends on the path, and decides who is blamed.

    - `foo(f: Callable[[str], str])` calls `f(1)`: `foo` broke its promise.
    - The function given as `f` gives back a number: the caller who gave it.
    - The function `adder` returns is called with a string: the caller.
    - The function `adder` returns gives back a string: `adder`.
    """
    path = c.check.get("path") or []
    calls = [step for step in path if step["kind"] in ("argument", "result")]
    if len(calls) != 2:
        return None
    outer, inner = calls
    function = c.check.get("function")
    if function is None:
        return None
    given = c.check.get("value")
    if c.element:
        given = "%s whose %s is %s" % (_pll_describe_type(c.actual), c.element, c.e.facts.get("element_value") or given)
    else:
        given = "`%s`, %s" % (given, _pll_describe_type(c.actual))
    wanted = c.wanted
    annotation = outer.get("annotation")
    if outer["kind"] == "argument":
        parameter = "`%s`" % outer["name"]
        if inner["kind"] == "argument":
            return "`%s` calls %s with %s, but its annotation says %s takes %s." % (
                function, parameter, given, parameter, wanted
            ), [
                "Call %s with %s, as `%s: %s` promises." % (parameter, wanted, outer["name"], annotation),
                "Or, if %s should take something else, change that annotation." % parameter,
            ]
        return "The function given to `%s` as %s should give back %s, but it gave back %s." % (
            function, parameter, wanted, given
        ), [
            "`%s: %s` says what the function given as %s must return." % (outer["name"], annotation, parameter),
            "Give `%s` a function that returns %s." % (function, wanted),
        ]
    if inner["kind"] == "argument":
        return "The function `%s` returns takes %s, but it was given %s." % (function, wanted, given), [
            "Call it with %s, as `%s`'s return annotation, `%s`, says." % (wanted, function, annotation),
        ]
    return "`%s` says the function it returns gives back %s, but it gave back %s." % (function, wanted, given), [
        "`%s`'s return annotation, `%s`, says what that function gives back." % (function, annotation),
        "Change the function `%s` returns, or the annotation." % function,
    ]


@_pll_explains("NotAType")
def _pll_explain_not_a_type(e):
    """An annotation that is not a type (bootstrap/contracts.py)."""
    facts = e.facts.get("not_a_type") or {}
    written = facts.get("annotation") or "?"
    function, name, kind = facts.get("function"), facts.get("name"), facts.get("kind")
    if kind == "return" and function:
        subject = "`%s`'s return annotation" % function
    elif kind == "argument" and function:
        subject = "The annotation of `%s` in `%s`" % (name, function)
    elif kind == "annotation" and function:
        subject = "An annotation of `%s`" % function
    elif name:
        subject = "The annotation of `%s`" % name
    else:
        subject = "This annotation"
    reason = facts.get("reason")
    value, value_type = facts.get("value"), facts.get("value_type")
    literal = value is not None and value == written
    how_to_fix = ["An annotation names a type, such as `int`, `str`, `list[float]` or one of your classes."]
    if reason == "undefined":
        missing = facts.get("missing") or written
        headline = (
            "%s names `%s`, which is not defined." % (subject, missing)
            if written == missing
            else "%s, `%s`, names `%s`, which is not defined." % (subject, written, missing)
        )
        how_to_fix = [
            "A name in quotes in an annotation is the name of a type, looked up when it is needed.",
            "Check the spelling, or define `%s` in the file." % missing,
        ]
    elif reason == "string":
        headline = "%s, `%s`, holds the string %s, not a type." % (subject, written, value)
        how_to_fix.append(
            "To name a class defined further down the file, put its name in quotes in the annotation itself."
        )
    elif reason == "ambiguous":
        headline = "%s, `%s`, allows more than one kind of function, and the one given fits several." % (
            subject, written
        )
        how_to_fix = ["Use one function type in the annotation, so the function given has one contract to meet."]
    elif reason in ("number", "function", "module", "value") and value is not None:
        what = {"number": "a number", "function": "a function", "module": "a module"}.get(
            reason, _pll_with_article(_pll_describe_type(value_type)) if value_type else "a value"
        )
        # A function or a module is named by the annotation already; a
        # value it holds is worth saying.
        headline = (
            "%s, `%s`, is %s, not a type." % (subject, written, what)
            if literal or reason in ("function", "module")
            else "%s, `%s`, is %s (%s), not a type." % (subject, written, what, value)
        )
    else:
        headline = "%s, `%s`, is not a type." % (subject, written)
    file, line = facts.get("file"), facts.get("line")
    if reason != "undefined" or line is None:
        file, line = e.file, e.line
    return {
        "id": "not-a-type",
        "errorType": "NotAType",
        "headline": headline,
        "howToFix": how_to_fix,
        "fileName": file,
        "lineNumber": line,
        "column": None,
        "nameToken": name,
    }


def _pll_clean_type_name(type_name):
    # Anywhere, not just at the start: a class can arrive as `class
    # __main__.ITunesSong`, with the prefix in the middle.
    cleaned = type_name.replace(_PLL_MAIN_PREFIX, "")
    return _PLL_COURSE_NAME_FOR.get(cleaned, cleaned)


def _pll_describe_type(type_name):
    """`int` -> "a whole number (`int`)", `Dog` -> "`Dog`"."""
    name = _pll_clean_type_name(type_name)
    if name in ("None", "NoneType"):
        return "`None`"
    friendly = _pll_type_words(name, article=True)
    return "%s (`%s`)" % (friendly, name) if friendly else "`%s`" % name


def _pll_describe_types(types):
    """["int", "NoneType"] -> "a whole number (`int`) or `None`"."""
    described = [_pll_describe_type(t) for t in types]
    if not described:
        return "a different type"
    if len(described) == 1:
        return described[0]
    return "%s or %s" % (", ".join(described[:-1]), described[-1])


def _pll_bool_as_number_note(expected, actual):
    """A `bool` rejected for `int`/`float` is PLL's rule, not Python's - and
    only the teaching levels', the only ones that reject it - so say so
    rather than leaving the student to wonder why `True` is not a number."""
    if actual != "bool" or not any(t in ("int", "float") for t in expected):
        return None
    return (
        "At `#level beginner` and `#level intermediate`, `True` and `False` are not accepted as numbers, even"
        " though Python counts them as `1` and `0`."
    )


def _pll_field_being_replaced(line, name):
    """The field `line` reads from `name`, when the line replaces `name`
    itself: `ac = ac.balance + amt` reads `ac.balance` and assigns `ac`, and
    the field it reads is the one that was meant to change."""
    if line is None or name is None:
        return None
    escaped = _pll_src_re.escape(name)
    assigns = _pll_src_re.match(r"\s*%s\s*=(?!=)(.*)$" % escaped, line)
    if assigns is None:
        return None
    reads = _pll_src_re.search(r"\b%s\.([A-Za-z_]\w*)\b(?!\s*\()" % escaped, assigns.group(1))
    return reads.group(1) if reads else None


def _pll_with_article(described):
    """"a whole number (`int`)" stays as it is; "`Account`" becomes "an `Account`"."""
    if not described.startswith("`") or described == "`None`":
        return described
    return "%s %s" % ("an" if _pll_src_re.match(r"`[AEIOUaeiou]", described) else "a", described)


def _pll_conversion_for(expected, actual):
    """The conversion that would most likely fix this, if there is an obvious one."""
    if len(expected) != 1 or actual is None:
        return None
    to = expected[0]
    if to == "int" and actual in ("str", "float"):
        return "int"
    if to == "float" and actual == "str":
        return "float"
    if to == "str" and actual in ("int", "float", "bool"):
        return "str"
    return None


def _pll_members_phrase(element):
    """How to describe "all the things inside" for the failing element's kind."""
    if element.startswith("the value for key"):
        return "every value in"
    if element.startswith("key "):
        return "every key in"
    return "every item in"


def _pll_describe_element(element):
    """A contract's words for a part of a collection ("item 2", "value of key
    'a'"), as something to point at."""
    if element.startswith("value of key "):
        return "the value for key " + _pll_plain_key(element[len("value of key ") :])
    if element.startswith("key "):
        return "key " + _pll_plain_key(element[len("key ") :])
    if element.startswith("["):
        return "one of the values"
    return element


def _pll_plain_key(key):
    """A key as a contract quotes it - Python's `repr`, so `'a'` - in the
    double quotes PLL writes a string in, so that the key and the value
    beside it read alike. A key that is not a plain string, or whose quotes
    Python chose because of what is in it, is left as Python wrote it."""
    simple = _pll_src_re.fullmatch(r"'([^'\"\\]*)'", key)
    return '"%s"' % simple.group(1) if simple else key


def _pll_class_given(c):
    """The class itself where one made from it was meant, whatever was annotated."""
    found = _pll_src_re.match(r"class (.+)$", c.actual) if c.actual is not None else None
    if found is None or c.element is not None:
        return None
    given = _pll_clean_type_name(found.group(1))
    # `ITunesSong` rather than `ITunesSong(...)`. The two annotations read
    # almost identically - "expects s to be ITunesSong, but got class
    # ITunesSong" - so the difference has to be spelled out.
    if c.kind == "return":
        where = "%s returned" % c.owner
    elif c.kind == "variable":
        where = "%s was given" % c.named
    else:
        where = "%s was given" % c.owner
    return "%s the class `%s` itself, not one made from it." % (where, given), [
        "`%s` on its own is the blueprint; `%s(...)` makes one." % (given, given),
        "Add the brackets and the values for its fields: `%s(...)`." % given,
    ]


def _pll_data_path(c):
    """A part of a dataclass value, as code that reaches it: `t.right.value`,
    `songs[0].year` - None unless the path into the value goes through a
    field of one."""
    path = c.check.get("path") or []
    steps = path[1:]
    if not steps or not any(step["kind"] == "field" for step in steps) or c.name is None:
        return None
    reached = c.name
    for step in steps:
        if step["kind"] == "field":
            reached += "." + step["name"]
        elif step["kind"] == "item":
            reached += "[%d]" % step["index"]
        elif step["kind"] == "value":
            reached += "[%s]" % step["key"]
        else:
            return None
    return reached


def _pll_tc_arity(c):
    """A function given where the annotation wants one that takes so many
    arguments, and it takes a different number."""
    arity = c.check.get("arity")
    if not arity or c.kind not in ("argument", "variable"):
        return None
    wanted = arity["wanted"]
    parameters = arity["parameters"]
    given = "it takes %s" % (
        "no arguments" if not parameters else "%s (%s)" % (_pll_plural(len(parameters), "argument"), _pll_list_names(parameters))
    )
    annotation = c.check.get("annotation") or c.annotation
    return "%s expects %s to be a function that takes %s (`%s`), but %s." % (
        c.owner if c.kind == "argument" else "The annotation", c.named, _pll_plural(wanted, "argument"), annotation, given
    ), [
        "Give a function that takes %s, as `%s` says." % (_pll_plural(wanted, "argument"), annotation),
        "Or, if %s should take a different number, change the annotation." % c.named,
    ]


def _pll_tc_argument(c):
    """An argument that does not match its parameter's annotation."""
    arity = _pll_tc_arity(c)
    if arity is not None:
        return arity
    reached = _pll_data_path(c)
    if reached is not None:
        value = c.e.facts.get("element_value")
        return "%s expects %s to be `%s`, but `%s` is %s." % (
            c.owner, c.named, c.check.get("annotation"), reached, value or "not"
        ), [
            "Look at `%s` in the value you passed for %s: all of it has to match the annotation." % (reached, c.named),
        ]
    if c.element:
        # What the element *is*, when Python could read it - "item 0 is
        # not" left the student to go and find out.
        value = c.e.facts.get("element_value")
        is_ = " is %s" % value if value is not None else " is not"
        return "%s expects %s %s to be %s, but %s%s." % (
            c.owner, _pll_members_phrase(c.element), c.named, c.wanted, c.element, is_
        ), [
            "Look at %s of the %s you passed for %s." % (c.element, c.actual or "value", c.named),
            "Every one has to match the annotation, not just the first.",
        ]
    got = ", but got %s" % _pll_describe_type(c.actual) if c.actual else ""
    headline = "%s expects %s to be %s%s." % (c.owner, c.named, c.wanted, got)
    supplied = c.called_by
    if supplied is not None:
        # Nothing on this line passed anything, so the advice is about the
        # `def` - and the generic "convert it" / "change the annotation"
        # bullets would only repeat that in two more ways.
        if supplied == "reactor":
            how_to_fix = [
                "The reactor calls %s with its state: the `init` value to start with, then whatever the handlers"
                " return. So %s is the reactor's state, not a value from this line." % (c.owner, c.named)
            ]
        else:
            taker = _PLL_FUNCTION_TAKERS.get(supplied)
            calls = taker["calls"] if taker else "`%s` calls %s for you" % (supplied, c.owner)
            how_to_fix = ["%s, so %s is whatever it hands over - not a value from this line." % (calls, c.named)]
        if c.annotation is not None and c.actual is not None:
            how_to_fix.append(
                "Annotate %s as `%s` in %s, or change what %s is given so it hands over %s."
                % (
                    c.named,
                    _pll_clean_type_name(c.actual),
                    c.owner,
                    "the reactor" if supplied == "reactor" else "`%s`" % supplied,
                    c.wanted,
                )
            )
        if c.bool_note:
            how_to_fix.append(c.bool_note)
        return headline, how_to_fix
    how_to_fix = ["Check the value you passed for %s on this line." % c.named]
    if c.bool_note:
        how_to_fix.append(c.bool_note)
    if c.convert:
        how_to_fix.append("If it should be %s, convert it with `%s(...)`." % (c.wanted, c.convert))
    if c.annotation and c.actual:
        how_to_fix.append(
            "Or, if %s really should be %s, change its annotation in %s from `%s` to `%s`."
            % (c.named, _pll_describe_type(c.actual), c.owner, c.annotation, _pll_clean_type_name(c.actual))
        )
    return headline, how_to_fix


def _pll_tc_field(c):
    """A dataclass field given a value of the wrong type."""
    owner = c.check.get("owner") or "this class"
    value = c.check.get("value")
    # Python found another field this value fits, whose value fits here:
    # the two were given in each other's places, and converting one would
    # hide that.
    swapped = c.e.facts.get("swapped_with")
    if swapped is not None:
        return "The values for `%s` and `%s` of `%s` look swapped." % (c.name, swapped, owner), [
            "`%s` got `%s`, which fits `%s` - and the other way round."
            % (c.name, value if value is not None else "?", swapped),
            "Give the values in the order the fields are written in `class %s`." % owner,
        ]
    if value is not None:
        got = "`%s`" % value
    elif c.actual:
        got = _pll_describe_type(c.actual)
    else:
        got = "something else"
    if c.check.get("assigned"):
        how_to_fix = ["Check the value assigned to the `%s` field on this line." % c.name]
    else:
        how_to_fix = ["Check the values given to `%s(...)`, in the order its fields are written." % owner]
    if c.convert is not None:
        how_to_fix.append("If it should be %s, convert it with `%s(...)`." % (c.wanted, c.convert))
    if c.annotation is not None and c.actual is not None:
        how_to_fix.append(
            "Or change the field's annotation from `%s` to `%s`." % (c.annotation, _pll_clean_type_name(c.actual))
        )
    return "The `%s` field of `%s` should be %s, but got %s." % (c.name, owner, c.wanted, got), how_to_fix


def _pll_tc_return(c):
    """A return value that does not match the function's annotation."""
    # A `None` result has three quite different causes, and one message for
    # all of them describes the symptom rather than any of them.
    if c.actual in ("None", "NoneType"):
        return _pll_none_returned(c)
    if c.element:
        # One item of a collection: the collection is what was asked for,
        # so the item is the thing to change - not the annotation's container.
        value = c.e.facts.get("element_value")
        container = _pll_clean_type_name(c.actual) if c.actual else "value"
        how_to_fix = [
            "Look at %s of the %s this line returns: every one has to match the annotation, not just the first."
            % (c.element, container)
        ]
        element_type = c.e.facts.get("element_type")
        written = c.check.get("annotation")
        if written is not None and c.annotation is not None and element_type is not None:
            # Only where the annotation names the type once, so which one to
            # change is not a guess.
            pattern = r"\b%s\b" % _pll_src_re.escape(c.annotation)
            if len(_pll_src_re.findall(pattern, written)) == 1:
                replaced = _pll_src_re.sub(pattern, lambda _: element_type, written)
                how_to_fix.append(
                    "Or, if that is what it should hold, change the annotation from `%s` to `%s`." % (written, replaced)
                )
        return "%s says it returns %s, with %s it %s, but %s%s." % (
            c.owner,
            "`%s`" % written if written is not None else "a %s" % container,
            _pll_members_phrase(c.element),
            c.wanted,
            c.element,
            " is %s" % value if value is not None else " is not",
        ), how_to_fix
    got = _pll_describe_type(c.actual) if c.actual else "something else"
    if len(c.expected) == 1 and c.expected[0] in ("None", "NoneType"):
        how_to_fix = ["Use a bare `return`, or drop the `return` entirely."]
    elif c.convert:
        how_to_fix = ["Convert the returned value with `%s(...)`." % c.convert]
    else:
        how_to_fix = ["Return %s from this line." % _pll_with_article(c.wanted)]
    if c.bool_note:
        how_to_fix.append(c.bool_note)
    if c.annotation and c.actual:
        how_to_fix.append(
            "Or change %s's return annotation from `%s` to `%s`."
            % (c.owner, c.annotation, _pll_clean_type_name(c.actual))
        )
    return "%s says it returns %s, but this line returns %s." % (c.owner, c.wanted, got), how_to_fix


def _pll_none_returned(c):
    """A function annotated to return something that produced `None`.

    Three causes, which need different things said about them: it ran off
    its end, with no `return` on the path taken; a `return` ran, and what it
    returned was already `None` - usually a name assigned from
    `.append(...)`; or a `match` fitted no case, so nothing happened and the
    function then ran off its end.
    """
    owner, wanted = c.owner, c.wanted
    annotate = "Or annotate the return type as `None` if %s is not meant to return anything." % owner
    returned = _pll_src_re.match(r"\s*return\s+(\S.*?)\s*$", c.line) if c.line is not None else None
    if returned is not None:
        expression = returned.group(1)
        assigned = (c.e.facts.get("assigned") or {}).get(expression)
        if (
            _pll_src_re.fullmatch(r"[A-Za-z_]\w*", expression)
            and assigned is not None
            and "." in assigned["call"]
            and assigned["call"].rsplit(".", 1)[1] in _PLL_RETURNS_NONE
        ):
            method = assigned["call"].rsplit(".", 1)[1]
            return "%s returned `None`, because `%s` was set to the result of `.%s(...)` on line %d." % (
                owner, expression, method, assigned["line"]
            ), [
                "`.%s(...)` changes the list in place and gives back nothing." % method,
                "Call it on its own line - `%s.%s(...)` - rather than assigning its result back to `%s`."
                % (expression, method, expression),
            ]
        if expression == "None":
            # Written out: `return None`, where something was meant to come back.
            return "%s returns `None` on this line, but it should return %s." % (owner, wanted), [
                "Return %s here, or annotate %s as returning `None`." % (wanted, owner)
            ]
        return "%s should return %s, but `%s` is `None` here." % (owner, wanted, expression), [
            "This line did return - what it returned was nothing.",
            "Check where `%s` was last set." % expression,
            annotate,
        ]
    # No `return` ran at all. If the function ends in a `match`, no case
    # fitting is overwhelmingly the reason.
    returned_none = c.e.facts.get("returned_none") or {}
    match = returned_none.get("match")
    if match is not None:
        how_to_fix = []
        # When what is matched is annotated with a union, the variants with
        # no `case` can be named outright.
        missing = match.get("uncovered") or []
        if missing:
            how_to_fix.append("There is no `case` for %s." % " or ".join("`%s`" % name for name in missing))
        else:
            how_to_fix.append("Every possible value of `%s` needs a `case`." % match["subject"])
            if match.get("has_list") and not any(p.strip() == "[]" for p in match.get("patterns") or []):
                how_to_fix.append("The empty list, `case []:`, is the one most often left out.")
        for pattern in match.get("fixed_length") or []:
            parts = [part.strip() for part in pattern[1:-1].split(",")]
            how_to_fix.append(
                "`case %s:` matches a list of exactly %d items; for a first and a rest, write `[%s, *%s]`."
                % (pattern, len(parts), ", ".join(parts[:-1]), parts[-1])
            )
        # Deliberately no "annotate it as `None`" here. A `match` that fitted
        # nothing is a missing case; annotating the return type as `None`
        # would silence the symptom and keep the bug.
        return "No `case` in %s fitted `%s`, so nothing was returned." % (owner, match["subject"]), how_to_fix
    headline = "%s should return %s, but it finished without returning a value." % (owner, wanted)
    # A branch that ends in `print` is the single commonest version of this,
    # and it shows the right answer on screen - so the function looks fine.
    # Once found it is the cause, so the general advice is left out.
    printed = returned_none.get("printed")
    if printed is not None:
        expression = printed.get("expression")
        return headline, [
            "Line %d ends its branch with `print`: did you mean %s"
            % (printed["line"], "`return %s`?" % expression if expression is not None else "`return` instead of `print`?"),
            "`print` shows a value on screen; `return` hands it back to whatever called the function.",
        ]
    return headline, [
        "Make sure every path through the function reaches a `return`.",
        "An `if` with no `else` falls off the end, and Python then returns `None`.",
        annotate,
    ]


def _pll_tc_variable(c):
    """An annotated variable assigned a value of the wrong type."""
    if c.element:
        return "%s is annotated so %s it is %s, but %s is not." % (
            c.named, _pll_members_phrase(c.element), c.wanted, c.element
        ), ["Look at %s of the value assigned to %s." % (c.element, c.named)]
    got = _pll_describe_type(c.actual) if c.actual else "a different type"
    headline = "%s is annotated as %s, but %s was assigned here." % (c.named, c.wanted, got)
    # `ac = ac.balance + amt`, where `ac.balance = ...` was meant: the line
    # reads one of the variable's own fields, so that field is the target.
    field = _pll_field_being_replaced(c.line, c.name)
    if field is not None and c.name is not None:
        rhs = _pll_src_re.search(r"=\s*(.+)$", c.line or "")
        rhs = rhs.group(1).strip() if rhs else "..."
        return headline, [
            "To change the `%s` field of %s, assign to the field: `%s.%s = %s`." % (field, c.named, c.name, field, rhs),
            "`%s = ...` replaces the whole %s, field and all."
            % (c.name, "`%s`" % c.annotation if c.annotation is not None else "value"),
        ]
    # "Assign `Account` to `ac`" read as assigning the class itself, so a
    # class gets an article, the way a gloss like "a whole number" has one.
    how_to_fix = ["Assign %s to %s." % (_pll_with_article(c.wanted), c.named)]
    if c.bool_note:
        how_to_fix.append(c.bool_note)
    if c.convert:
        how_to_fix.append("You can convert the value with `%s(...)`." % c.convert)
    if c.annotation and c.actual:
        how_to_fix.append(
            "Or change %s's annotation from `%s` to `%s`." % (c.named, c.annotation, _pll_clean_type_name(c.actual))
        )
    return headline, how_to_fix


def _pll_tc_unfamiliar(c):
    """A contract on something none of the rules above knows: still say what
    kind of problem this is, and pass the contract's own sentence through
    rather than inventing detail."""
    return "A value does not match the type annotation written for it.", [
        _pll_src_re.split(r"\r?\n", c.e.message)[0].strip(),
        "Either pass a value of the annotated type, or change the annotation.",
    ]
