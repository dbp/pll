# The static checks' findings, worded for the student: what each kind of
# finding says, and what to do about it. `_pll_static_analyze`
# (staticAnalysis.py) finds them; each kind's wording is registered here
# under its `id`.

import re as _pll_src_re

#: What each kind of static finding says, by its `id`.
_PLL_STATIC_WORDING = {}

#: The names in `_PLL_NOT_A_TYPE` that really are functions PLL provides,
#: for the wording that says so. `image` is not one - nothing is called
#: `image` - and `row` is a method of a table rather than a function that
#: makes one, so both get the plain "not a type" wording.
_PLL_FUNCTIONS_NOT_TYPES = frozenset(("table", "reactor"))


def _pll_static_findings(code, level, filename, session_key=None):
    """The static checks' findings in `code`, worded: the host's `AnalysisFinding`s."""
    return [_pll_word_static(f, level, filename) for f in _pll_static_analyze(code, level, filename, session_key)]


def _pll_word_static(finding, level, filename):
    """`finding`, as `_pll_finding` made it, with what it says to the student."""
    word = _PLL_STATIC_WORDING.get(finding["id"])
    if word is None:
        headline, how_to_fix = "PLL found a problem here (`%s`) but has no explanation for it." % finding["id"], []
    else:
        headline, how_to_fix = word(finding, level)
    return {
        "id": finding["id"],
        "errorType": finding["error_type"],
        "headline": headline,
        "howToFix": how_to_fix,
        "fileName": filename,
        "lineNumber": finding["line_number"],
        "column": finding["column"],
        "nameToken": finding["name_token"],
        "severity": finding["severity"],
        "origin": "static",
        "level": level,
    }


def _pll_words(*kinds):
    """Register the wording of the findings of `kinds`: a function of the
    finding and the level, giving `(headline, how_to_fix)`."""

    def register(word):
        for kind in kinds:
            _PLL_STATIC_WORDING[kind] = word
        return word

    return register


#: Where the other binding of a shadowed name is, by its scope's kind.
_PLL_OUTER_SCOPE = {
    "module": "the file",
    "function": "an enclosing function",
    "lambda": "an enclosing function",
    "class": "an enclosing class",
    "comprehension": "an enclosing comprehension",
}

#: What a binding is, by how it was made.
_PLL_BINDING_NOUN = {
    "argument": "parameter",
    "for": "loop variable",
    "functiondef": "function",
    "classdef": "class",
    "import": "import",
    "importfrom": "import",
    "capture": "name in a `case`",
    "assign": "variable",
    "annassign": "variable",
    "augassign": "variable",
    "walrus": "variable",
    "with": "variable",
}

#: The library a name every session starts with comes from.
_PLL_LIBRARY_NOUN = {
    "image": "the image library",
    "table": "the table library",
    "reactor": "the reactor library",
}


@_pll_words("shadowing")
def _pll_word_shadowing(f, level):
    name = f["name_token"] or "this name"
    outer_line = f.get("outer_line_number")
    outer_noun = _PLL_OUTER_SCOPE.get(f.get("outer_scope_kind"), "an outer scope")
    known = outer_line is not None and outer_line > 0
    inner = _PLL_BINDING_NOUN.get(f.get("binding"), "name")
    outer = _PLL_BINDING_NOUN.get(f.get("outer_binding"), "name")
    # The other one comes later in the file, so it was not "already" there:
    # the two simply share a name, and either can change.
    if known and f["line_number"] is not None and outer_line > f["line_number"]:
        return "`%s` names two things: this %s, and a %s in %s, on line %d." % (
            name, inner, outer, outer_noun, outer_line
        ), [
            "Give one of them another name - this %s, or the %s on line %d - so each name means one thing."
            % (inner, outer, outer_line)
        ]
    where = " (first defined on line %d, in %s)" % (outer_line, outer_noun) if known else " in %s" % outer_noun
    return "`%s` is already defined%s." % (name, where), [
        "Rename this %s to something distinct (e.g. `%s_inner`, `local_%s`, or whatever describes its role)."
        % (inner, name, name),
        "Or, if you want to use the outer `%s`, just read it directly without making a new %s."
        % (name, "parameter" if inner == "parameter" else "variable"),
    ]


@_pll_words("shadowing-builtin")
def _pll_word_shadowing_builtin(f, level):
    name = f["name_token"] or "this name"
    return "`%s` is the name of a Python built-in." % name, [
        "Pick a different name. Common patterns: `my_%s`, `%s_value`, `%ss` (plural), or a more specific noun"
        " describing what this value represents." % (name, name, name)
    ]


@_pll_words("shadowing-library")
def _pll_word_shadowing_library(f, level):
    """A name every session starts with, like `circle` or `table`."""
    name = f["name_token"] or "this name"
    noun = _PLL_LIBRARY_NOUN.get(f.get("library"), "the PLL libraries")
    binding = f.get("binding")
    if binding in ("import", "importfrom"):
        # The fix is the import's own `as`, not a rename of anything of theirs.
        module = f.get("module") or "module"
        alias = module.split(".")[0] + name[:1].upper() + name[1:]
        written = (
            "from %s import %s as %s" % (module, name, alias)
            if binding == "importfrom"
            else "import %s as %s" % (name, alias)
        )
        return "`%s` is already defined by %s, and this import replaces it." % (name, noun), [
            "Import it under another name: `%s`, and use `%s` where you mean that one." % (written, alias)
        ]
    if binding in ("argument", "for"):
        what = _PLL_BINDING_NOUN[binding]
        return "`%s` is already a name in PLL - one of %s's - and this %s hides it." % (name, noun, what), [
            "Give the %s another name - for example `%s_value`, or a word for what it holds." % (what, name)
        ]
    return "`%s` is already defined by %s." % (name, noun), [
        "Pick a different name for your definition - for example `my_%s`, `%s_value`, or a word that describes"
        " what yours represents." % (name, name),
        "If you meant to use the library's `%s`, call it directly instead of defining a new `%s` of your own."
        % (name, name),
    ]


@_pll_words("reassignment")
def _pll_word_reassignment(f, level):
    name = f["name_token"] or "this name"
    first = f.get("first_line_number")
    # Line 0 is a binding the session already had: a prompt line after Run File.
    where = " (first assigned on line %d)" % first if first is not None and first > 0 else ""
    headline = "`%s` is already assigned%s." % (name, where)
    rename = "If you want a different value, give it a different name (e.g. `%s_doubled`, `new_%s`, `%s2`)." % (
        name, name, name
    )
    # Refused here, but not inside a function: then the fix is to move the
    # work into one.
    if not _pll_refuses_reassignment(level, "function"):
        return headline, [
            rename,
            "If you're trying to update a value (`x = x + 1`, accumulators, running totals), wrap the work in a"
            " function and rebind `%s` from the function's return value: `%s = compute_%s(...)`." % (name, name, name),
        ]
    fixes = [
        rename,
        "If you're trying to update a value (`x = x + 1`, accumulators, running totals), use a built-in like"
        " `sum(...)`, `max(...)`, or a small helper function that returns the new value instead.",
    ]
    # Inside a function this is exactly what `intermediate` exists for, and
    # a student has no way to know that from here.
    if f.get("scope_kind") == "function" and not _pll_refuses_reassignment(_PLL_LEVEL_INTERMEDIATE, "function"):
        fixes.append(
            "`#level intermediate` allows changing a variable inside a function, which is what a running total needs."
        )
    return headline, fixes


@_pll_words("duplicate-definition")
def _pll_word_duplicate_definition(f, level):
    """Two `def`s (or two `class`es) with the same name.

    Python keeps the second and throws the first away silently, which is how
    a test copied without renaming it disappears. Its own finding, not a
    reassignment: that advice is about variables, and the fix here is to
    rename one of them.
    """
    name = f["name_token"] or "this name"
    kind = "classes" if f.get("definition_kind") == "class" else "functions"
    first = f.get("first_line_number")
    where = " (lines %s and %s)" % (first, f["line_number"]) if isinstance(first, int) and first > 0 else ""
    return "There are two %s named `%s`%s." % (kind, name, where), [
        "Rename one of them. Python keeps only the second, so the first never runs.",
        "A test copied and not renamed vanishes this way: only the last one is run."
        if kind == "functions" and name.startswith("test_")
        else "Both definitions are kept in the file, but only the last name points at anything.",
    ]


@_pll_words("disallowed-keyword")
def _pll_word_disallowed_keyword(f, level):
    """`global` or `nonlocal` at a level that refuses them: each lets a
    function rebind a name in an enclosing scope, which is the action at a
    distance both levels keep beginners from."""
    keyword = "nonlocal" if f.get("keyword") == "nonlocal" else "global"
    names = ", ".join("`%s`" % n for n in f.get("names") or [])
    named = " " + names if names else ""
    if keyword == "global":
        fixes = [
            "Pass%s into this function as an argument instead of declaring it `global`." % (named or " the value"),
            "If the function needs to *change* a value, return the new value and let the caller decide what to do"
            " with it (e.g. `x = update(x)`).",
        ]
    else:
        fixes = [
            "Return%s from this inner function and have the outer function rebind it explicitly (e.g. `x = inner(x)`)."
            % (named or " the new value"),
            "If the inner function only needs to *read* the outer name, just use it directly - you don't need"
            " `nonlocal` for that.",
        ]
    # The level that does allow it. Without this the finding says what is
    # forbidden and never what to do if the student really does want it.
    fixes.append("`#level advanced` allows `%s`, if you have a reason to use it." % keyword)
    return "`%s` is not allowed at the %s level." % (keyword, level), fixes


@_pll_words("unbinding")
def _pll_word_unbinding(f, level):
    """`del x` at a level that refuses it. Taking an item out of a value,
    `del d[key]`, is allowed, so the wording says that too."""
    names = f.get("names") or [f["name_token"]]
    headline = "`del` removes the name%s %s, which is not allowed at the %s level." % (
        "s" if len(names) > 1 else "", _pll_list_names(names), level
    )
    if f.get("loop_variable"):
        fixes = [
            "If this is meant to leave the item out: `del %s` removes only the name `%s`, not the item from what the"
            " loop goes through. Build a new list of the items to keep instead." % (names[0], names[0])
        ]
    else:
        fixes = [
            "Leave %s in place: nothing needs a name removed%s." % (
                _pll_list_names(names),
                ", and a function's names go away by themselves when it returns"
                if f.get("scope_kind") == "function" else "",
            ),
            "`del` can still take an item out of a dictionary or a list: `del d[key]`, `del items[0]`.",
        ]
    fixes.append("`#level advanced` allows removing a name with `del`, if you have a reason to.")
    return headline, fixes


class _PllNameReading:
    """An `undefined-name` finding, read as the error it foresees: what the
    rules that word a NameError as it happens (`_pll_name_wording`) read."""

    def __init__(self, f):
        self.name = f["name_token"]
        self.text = f.get("text")
        self.message = f.get("says") or ""
        self.facts = {
            key: f[key]
            for key in ("defined_on", "deleted_on", "except_on", "being_defined", "called_on", "called")
            if key in f
        }
        self.source = ""
        self.info = {"lineNumber": f["line_number"]}


@_pll_words("undefined-name")
def _pll_word_undefined_name(f, level):
    """A name read where it has no value: worded as the error a run would
    raise there, so that the same mistake reads the same before and during."""
    return _pll_name_wording(_PllNameReading(f))


# Code that would otherwise run without a word being said. Each is valid
# Python that does nothing, or something other than what was meant: a test
# written without `assert` always passes; an `assert` on a tuple is always
# true; a method named but not called is the method itself; an annotation
# naming a function checks nothing. Without a finding the student's only
# evidence is a program that seems to work.


@_pll_words("unused-comparison")
def _pll_word_unused_comparison(f, level):
    """`pen_cost(0, "huskies") == 1`: a test written without `assert`."""
    # Their own comparison, not `assert ...`.
    shown = "`assert %s`" % f["expression"] if f.get("expression") else "`assert ...`"
    return "This comparison's answer is not used, so nothing checks it.", [
        "Did you mean %s? Without `assert` the comparison is worked out and thrown away, so the test always passes."
        % shown,
        "At the top level a line like this is displayed; inside a function nothing shows it.",
    ]


@_pll_words("unused-value")
def _pll_word_unused_value(f, level):
    """`ac.balance + amt` on a line of its own."""
    expression = f.get("expression")
    # `ac.balance + amt` reads a field and adds to it: assigning the result
    # back to that field is nearly always what was meant.
    field = _pll_src_re.match(r"([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*[-+*/]", expression) if expression is not None else None
    if expression is None:
        fixes = ["Use it: `return` it, assign it to a name, or pass it to `print`."]
    elif field:
        fixes = [
            "To change `%s`, assign the result to it: `%s = %s`." % (field.group(1), field.group(1), expression),
            "Or, if this is the function's answer, return it: `return %s`." % expression,
        ]
    else:
        fixes = ["Did you mean `return %s`? On its own, the value is worked out and thrown away." % expression]
    return "This line works out a value and then throws it away.", fixes + [
        "Nothing in Python changes as a result of this line."
    ]


@_pll_words("assert-tuple")
def _pll_word_assert_tuple(f, level):
    """`assert(x, 1)`: a tuple, which is always true."""
    return "This `assert` has brackets around two things, so it is always true.", [
        "`assert(a, b)` checks a pair, and a pair is never false - the test passes whatever happens.",
        "Write `assert a == b`, with no brackets after `assert`.",
    ]


@_pll_words("is-literal")
def _pll_word_is_literal(f, level):
    """`x is 60.5`: `is`, where `==` was meant."""
    negated = f.get("operator") == "is not"
    literal = f.get("literal") or "a value"
    return "`%s` asks whether two things are the very same object, not whether they are equal." % (
        "is not" if negated else "is"
    ), [
        "To compare with `%s`, write `%s` instead." % (literal, "!=" if negated else "=="),
        "`is` is for `None`: `x is None`.",
    ]


@_pll_words("method-not-called")
def _pll_word_method_not_called(f, level):
    """`movies["rating"].mean`: the method, not its result."""
    method = f["name_token"] or "the method"
    return "`%s` is named here but never called." % method, [
        "Add the brackets: `.%s()`." % method,
        "Without them this is the method itself, which displays as `<bound method ...>`.",
    ]


@_pll_words("annotation-not-a-type")
def _pll_word_annotation_not_a_type(f, level):
    """`t: table`: the function that makes tables, not the type."""
    written = f["name_token"] or ""
    type_name = _PLL_NOT_A_TYPE.get(written)
    # What goes wrong depends on whether the name exists. `table` is a real
    # function, so the annotation is accepted and silently checks nothing;
    # `string` and `Float` are not names at all, so the line fails with a
    # NameError the moment it runs - and saying "accepted" there is false.
    exists = written in _PLL_FUNCTIONS_NOT_TYPES
    headline = (
        "`%s` is the function that makes a %s; the type is `%s`." % (written, written, type_name)
        if exists
        else "`%s` is not a type Python knows." % written
    )
    if type_name is None:
        return headline, ["Nothing about this value is being checked as a result."]
    return headline, [
        "Write `%s` instead." % type_name,
        "As it stands the annotation is accepted and nothing about this value is checked."
        if exists
        else "There is nothing called `%s`, so this line fails as soon as it runs." % written,
    ]


@_pll_words("test-not-named")
def _pll_word_test_not_named(f, level):
    """A function with an `assert` in it that nothing ever runs."""
    name = f["name_token"] or "this function"
    return "`%s` has an `assert` in it, but nothing ever runs it." % name, [
        "Rename it `test_%s` and it will run with the other tests." % name,
        "Only functions whose names start with `test_` are run automatically.",
    ]


@_pll_words("field-no-type")
def _pll_word_field_no_type(f, level):
    """`year` on a line of its own in a dataclass body."""
    name = f["name_token"] or "this field"
    return "The field `%s` has no type, so it is not a field at all." % name, [
        "Every field of a dataclass needs a type: `%s: int`, `%s: str`, and so on." % (name, name),
        # Not the NameError it would lead to: this is reported before the
        # program runs, so that error is never reached.
        "On a line of its own, `%s` only uses the name; it does not declare anything." % name,
    ]


@_pll_words("field-assigned-type")
def _pll_word_field_assigned_type(f, level):
    """`year = int` where `year: int` was meant."""
    name = f["name_token"] or "this field"
    type_name = f.get("written_type") or "int"
    return "`%s = %s` sets `%s` to the type itself; did you mean `%s: %s`?" % (
        name, type_name, name, name, type_name
    ), [
        "A field is declared with a colon, not an `=`.",
        "With an `=` there is no `%s` field, and the constructor ends up with the wrong number of arguments." % name,
    ]


@_pll_words("class-needs-dataclass")
def _pll_word_class_needs_dataclass(f, level):
    """A class with annotated fields and no `@dataclass`."""
    name = f["name_token"] or "this class"
    return "`%s` lists fields but has no `@dataclass`, so `%s(...)` takes no arguments." % (name, name), [
        "Write `@dataclass` on the line above `class %s`." % name,
        "Add `from dataclasses import dataclass` at the top of the file if it is not there.",
    ]


@_pll_words("compared-with-class")
def _pll_word_compared_with_class(f, level):
    """`if a == Boa:`: a value is never equal to the class it was made from."""
    name = f["name_token"] or "a class"
    return "`%s` is a class, so comparing a value with it is always False." % name, [
        "Use `match` to tell the kinds apart: `case %s(...):`." % name,
        "`%s` is the blueprint; a value made from it is never equal to it." % name,
    ]


# -- a `case` pattern's class --------------------------------------------------


def _pll_pattern_variants(subject, union, members):
    """"an `Animal` is a `Boa` or an `Armadillo`", or "`a` is ..." for a
    union written in the annotation itself."""
    kinds = _pll_listed([_pll_with_article("`%s`" % m) for m in members], "or")
    return "%s is %s" % (_pll_with_article("`%s`" % union) if union else "`%s`" % subject, kinds)


def _pll_pattern_fixes(name, subject, union, members):
    """Match one of them, or make `name` one of them."""
    classes = [m for m in members if m != "None"]
    cases = _pll_listed(["`case %s(...)`" % m for m in classes], "or")
    widened = " | ".join(members + [name])
    added = (
        "If %s is a new kind of `%s`, define `class %s` and add it: `%s = %s`."
        % (_pll_with_article("`%s`" % name), union, name, union, widened)
        if union
        else "If `%s` can be %s too, define `class %s` and add it to the annotation: `%s`."
        % (subject, _pll_with_article("`%s`" % name), name, widened)
    )
    return ["Match %s: %s." % ("one of them" if len(classes) > 1 else "it", cases), added]


def _pll_pattern_class_wording(name, subject, union, members, classes):
    """A `case` pattern naming a class nothing defines: what the subject can
    be, when its annotation says, or else the classes the program has."""
    if members:
        close = _pll_closest_name(name, [m for m in members if m != "None"])
        # A misspelling: the one answer, not the ways round it.
        return "There is no class `%s`: %s." % (name, _pll_pattern_variants(subject, union, members)), (
            ["Did you mean `%s`?" % close] if close else _pll_pattern_fixes(name, subject, union, members)
        )
    headline = "There is no class `%s` for this `case` to match." % name
    close = _pll_closest_name(name, classes)
    if close:
        return headline, ["Did you mean `%s`?" % close]
    return headline, (["The classes this program has are %s." % _pll_list_names(classes)] if classes else []) + [
        "If `%s` should be a class of its own, define it: `class %s:`." % (name, name)
    ]


@_pll_words("unknown-pattern-class")
def _pll_word_unknown_pattern_class(f, level):
    """`case Aardvark(b):` with no `Aardvark` anywhere: a NameError whenever
    the case is tried, which a program can go a long time without doing."""
    return _pll_pattern_class_wording(f["name_token"], f["subject"], f["union"], f["members"], f["classes"])


@_pll_words("pattern-never-matches")
def _pll_word_pattern_never_matches(f, level):
    """`case Circle():` on a value annotated `Light`: a class it is never."""
    name = f["name_token"]
    return "This `case` never matches: %s, never %s." % (
        _pll_pattern_variants(f["subject"], f["union"], f["members"]), _pll_with_article("`%s`" % name)
    ), _pll_pattern_fixes(name, f["subject"], f["union"], f["members"])
