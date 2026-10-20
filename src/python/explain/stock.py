# PLL's wording for the errors Python words badly for a beginner.
#
# Each rule reads Python's message and, where it needs more, the student's
# line and what Python found out about their code: Python says `pen_cost()
# missing 1 required positional argument: 'message'` without saying that
# `pen_cost` takes two, and the definition Python found does.
#
# A rule returns None when on a closer look it cannot say anything better
# than Python did, and the message is then shown as Python wrote it (the
# catch-all, in finding.py). That is the right default - a confident wrong
# explanation is worse than a terse right one - so rules match narrowly and
# give up readily. Several do nothing but delete Python's internal names
# (`__init__`, `types.UnionType`, `Table.`), which is worth a rule on its
# own: those names send a student looking for something they never wrote.

#: `(types, pattern, explain)` in the order they are tried.
_PLL_STOCK_RULES = []


def _pll_stock(types, pattern):
    """Register a rewording of Python's message `pattern` for errors of
    `types`: a function of the match and the error, giving `(headline,
    how_to_fix)`, or None to leave the error to the rules after it."""

    def register(explain):
        _PLL_STOCK_RULES.append((types.split(), _pll_src_re.compile(pattern), explain))
        return explain

    return register


@_pll_explains(
    "TypeError", "AttributeError", "ValueError", "IndexError", "RecursionError", "KeyError", "ModuleNotFoundError"
)
def _pll_explain_stock(e):
    for types, pattern, explain in _PLL_STOCK_RULES:
        if e.type not in types:
            continue
        found = pattern.search(e.message)
        said = explain(found, e) if found else None
        if said is not None:
            return ("stock-message",) + said
    return None


# -- shared wording -----------------------------------------------------------

#: Why a value is `None`, which is almost never obvious to a beginner.
_PLL_WHY_NONE = [
    "A function with no `return` gives back `None`.",
    "A method that changes something in place - `append`, `sort` - also gives back `None`.",
]

#: Everything a function can be handed to: a library function, or a handler keyword.
_PLL_CALLS_YOUR_FUNCTION = tuple(_PLL_FUNCTION_TAKERS) + _PLL_HANDLER_KEYWORDS

_PLL_COMPARISONS = ("<", ">", "<=", ">=", "==", "!=")


def _pll_last_segment(type_name):
    return type_name.split(".")[-1]


def _pll_friendly(type_name):
    """`str` -> "string". A class the student wrote keeps its own name."""
    name = _pll_last_segment(type_name)
    words = _pll_type_words(name)
    return words if words is not None else "`%s`" % name


def _pll_list_names(names):
    """`a`, `b` and `c` - for listing names in prose."""
    return _pll_listed(["`%s`" % name for name in names])


def _pll_listed(items, joined="and"):
    """a, b and c - or "or" - for listing anything in prose."""
    if len(items) <= 1:
        return "".join(items)
    return "%s %s %s" % (", ".join(items[:-1]), joined, items[-1])


def _pll_takes_clause(names, count):
    """"takes 2 arguments (`a`, `b`)", or "takes 2 arguments" if unknown."""
    if names:
        return "takes %s (%s)" % (_pll_plural(len(names), "argument"), _pll_list_names(names))
    return "takes %s" % _pll_plural(count, "argument")


def _pll_needs_more(name, missing, message):
    absent = _pll_src_re.findall(r"'(\w+)'", message)
    return "`%s` needs %s%s." % (name, _pll_plural(missing, "more argument"), ": " + _pll_list_names(absent) if absent else "")


def _pll_library_hint(name):
    return list(_PLL_LIBRARY_HINTS.get(name, []))


# -- what Python found the names to be ----------------------------------------


def _pll_defined_as(e, name):
    return (e.facts.get("definitions") or {}).get(name)


def _pll_parameters_of(e, name, which):
    """A function's parameters - those it requires, or every positional one."""
    found = _pll_defined_as(e, name)
    return found[which] if found and found["kind"] == "function" else None


def _pll_students_class(e, name):
    found = _pll_defined_as(e, name)
    return bool(found and found["kind"] == "class" and found["students"])


def _pll_fields_of(e, name):
    """The fields of one of the student's classes, or None when it has none."""
    found = _pll_defined_as(e, name)
    return found["fields"] if found and found["kind"] == "class" and found["fields"] else None


def _pll_union_members_of(e, name):
    found = _pll_defined_as(e, name)
    return found["members"] if found and found["kind"] == "union" and len(found["members"]) > 1 else None


# -- reading the student's line -----------------------------------------------
#
# Several rules want "the expression next to this `+`" or "the argument of
# this `filter(`", written exactly as the student wrote it. A regex could
# not see past a nested call - `"Total: " + add_shipping(pen_cost(10,
# "bravo"))` was answered with `str(add_shipping)`, converting the function
# rather than its result. Tokens let brackets balance and strings be
# skipped, which is all these rules need.

#: The calls on a line that are almost never what produced the offending
#: value, so they are only named when nothing else is there.
_PLL_WRAPPERS = frozenset(
    ("print", "str", "int", "float", "bool", "len", "list", "sorted", "round", "abs", "sum", "min", "max", "type", "repr")
)


class _PllToken:
    __slots__ = ("kind", "text", "start", "end")

    def __init__(self, kind, text, start, end):
        self.kind, self.text, self.start, self.end = kind, text, start, end


def _pll_line_tokens(line):
    """One line of Python, split into enough tokens to find an operand."""
    tokens = []
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if c == "#":
            break
        if c.isspace():
            i += 1
            continue
        start = i
        if c in "\"'":
            i += 1
            while i < n and line[i] != c:
                i += 2 if line[i] == "\\" else 1
            i = min(i + 1, n)
            tokens.append(_PllToken("str", line[start:i], start, i))
        elif c.isascii() and (c.isalpha() or c == "_"):
            while i < n and line[i].isascii() and (line[i].isalnum() or line[i] == "_"):
                i += 1
            tokens.append(_PllToken("name", line[start:i], start, i))
        elif c in "0123456789":
            while i < n and line[i] in "0123456789.":
                i += 1
            tokens.append(_PllToken("num", line[start:i], start, i))
        elif c in "([{":
            i += 1
            tokens.append(_PllToken("open", c, start, i))
        elif c in ")]}":
            i += 1
            tokens.append(_PllToken("close", c, start, i))
        else:
            two = line[i : i + 2]
            op = two if two in ("<=", ">=", "==", "!=", "**", "//") else c
            i += len(op)
            tokens.append(_PllToken("op", op, start, i))
    return tokens


def _pll_token(tokens, at):
    """The token at `at`, or None past either end."""
    return tokens[at] if 0 <= at < len(tokens) else None


def _pll_text_at(tokens, at):
    token = _pll_token(tokens, at)
    return token.text if token else None


def _pll_closing(tokens, open_at):
    """The index of the bracket closing the one opened at `open_at`, or -1."""
    depth = 0
    for i in range(open_at, len(tokens)):
        if tokens[i].kind == "open":
            depth += 1
        if tokens[i].kind == "close":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _pll_operand_from(line, tokens, at):
    """The expression starting at token `at`: a name, its attributes and calls."""
    if at >= len(tokens) or tokens[at].kind not in ("name", "num"):
        return None
    last, i = at, at + 1
    while i < len(tokens):
        following = _pll_token(tokens, i + 1)
        if tokens[i].text == "." and following is not None and following.kind == "name":
            last = i + 1
            i += 2
        elif tokens[i].kind == "open" and tokens[i].text != "{":
            shut = _pll_closing(tokens, i)
            if shut < 0:
                return None
            last = shut
            i = shut + 1
        else:
            break
    return line[tokens[at].start : tokens[last].end]


def _pll_operand_before(line, tokens, at):
    """The expression ending at token `at`, read backwards to where it starts."""
    if not 0 <= at < len(tokens):
        return None
    first = i = at
    while i >= 0:
        if tokens[i].kind == "close":
            # Walk back to the matching open bracket.
            depth, j = 0, i
            while j >= 0:
                if tokens[j].kind == "close":
                    depth += 1
                if tokens[j].kind == "open":
                    depth -= 1
                    if depth == 0:
                        break
                j -= 1
            if j < 0:
                return None
            first = j
            i = j - 1
            continue
        if tokens[i].kind in ("name", "num"):
            first = i
            before = _pll_token(tokens, i - 2)
            if _pll_text_at(tokens, i - 1) == "." and before is not None and before.kind == "name":
                i -= 2
                continue
            break
        if i == at:
            return None
        break
    if tokens[first].kind not in ("name", "num"):
        return None
    return line[tokens[first].start : tokens[at].end]


def _pll_concat_operands(line):
    """A string literal and the operand `+` joins it to, as written:
    `(text, value, text_first)`, or None."""
    tokens = _pll_line_tokens(line)
    for i, token in enumerate(tokens):
        if token.kind != "str":
            continue
        if _pll_text_at(tokens, i + 1) == "+":
            value = _pll_operand_from(line, tokens, i + 2)
            if value is not None:
                return token.text, value, True
        if _pll_text_at(tokens, i - 1) == "+" and i >= 2:
            value = _pll_operand_before(line, tokens, i - 2)
            if value is not None:
                return token.text, value, False
    return None


def _pll_attribute_receiver(line, attr):
    """The expression `.attr` is read from on `line`, as written."""
    if line is None:
        return None
    tokens = _pll_line_tokens(line)
    for i in range(2, len(tokens)):
        if tokens[i].text == attr and tokens[i - 1].text == ".":
            return _pll_operand_before(line, tokens, i - 2)
    return None


def _pll_subscript_receiver(line):
    """The expression subscripted on `line` - the `xs` of `xs[0]`."""
    if line is None:
        return None
    tokens = _pll_line_tokens(line)
    for i in range(1, len(tokens)):
        before = tokens[i - 1]
        if tokens[i].text == "[" and (before.kind == "name" or before.text in (")", "]")):
            return _pll_operand_before(line, tokens, i - 1)
    return None


def _pll_looped_over(line):
    """What `for ... in` loops over on `line`."""
    if line is None:
        return None
    tokens = _pll_line_tokens(line)
    if not tokens or tokens[0].text != "for":
        return None
    at = next((i for i, token in enumerate(tokens) if token.text == "in"), -1)
    return None if at < 0 else _pll_operand_from(line, tokens, at + 1)


def _pll_operand_beside(line, operator, side):
    """The operand on one side of the first `operator` on `line`."""
    if line is None:
        return None
    tokens = _pll_line_tokens(line)
    at = next((i for i, token in enumerate(tokens) if token.kind == "op" and token.text == operator), -1)
    if at < 0:
        return None
    return _pll_operand_before(line, tokens, at - 1) if side == "left" else _pll_operand_from(line, tokens, at + 1)


def _pll_call_on(line):
    """The call on `line` whose result the error is probably about: not a
    wrapper like `print`, unless it is the only call there."""
    names = _pll_src_re.findall(r"([A-Za-z_][\w.]*)\s*\(", line or "")
    if not names:
        return None
    return next((name for name in names if name not in _PLL_WRAPPERS), names[0])


def _pll_typed_operand(line, facts):
    """A `+` operand that holds what `input()` returned, and the sum with it
    converted: `age + 1` becomes `int(age) + 1`."""
    tokens = _pll_line_tokens(line)
    assigned = facts.get("assigned") or {}
    for i, token in enumerate(tokens):
        if token.text != "+":
            continue
        for at, side in ((i - 1, "left"), (i + 1, "right")):
            operand = _pll_token(tokens, at)
            if (
                operand is None
                or operand.kind != "name"
                or _pll_text_at(tokens, at + 1) == "("
                or _pll_text_at(tokens, at - 1) == "."
            ):
                continue
            if (assigned.get(operand.text) or {}).get("call") != "input":
                continue
            left = "int(%s)" % operand.text if side == "left" else _pll_operand_before(line, tokens, i - 1)
            right = "int(%s)" % operand.text if side == "right" else _pll_operand_from(line, tokens, i + 1)
            if left is None or right is None:
                continue
            return operand.text, "%s + %s" % (left, right)
    return None


def _pll_why_none(e, receiver, unknown="This value is `None`"):
    """Where the `None` came from, said about the student's own code, as
    `(subject, how_to_fix)`.

    `receiver` is what the line did something to - the `x` of `x.total`,
    the thing subscripted, looped over or added. If it is a call, that call
    gave back `None`. If it is a name, the call it was set from did, and
    saying which is the useful part: blaming the first call on the line
    named `print` in `print(x.total)`, where `print` only wraps the value.
    """
    call = _pll_src_re.match(r"([A-Za-z_][\w.]*)\s*\(", receiver) if receiver is not None else None
    if call:
        return "`%s(...)` gave back `None`" % call.group(1), _PLL_WHY_NONE
    if receiver is not None and _pll_src_re.fullmatch(r"[A-Za-z_][\w.]*", receiver):
        subject = "`%s` is `None`" % receiver
        # A parameter got its `None` from whoever called the function.
        frames = e.user_frames
        inside = frames[-1]["function"] if frames else None
        if inside is not None and receiver in (frames[-1]["parameters"] or []):
            caller = " on line %s" % frames[-2]["line"] if len(frames) >= 2 else ""
            return subject, [
                "`%s` is a parameter of `%s`, so the call%s gave it `None`." % (receiver, inside, caller)
            ] + _PLL_WHY_NONE
        set_from = (e.facts.get("assigned") or {}).get(receiver)
        if set_from is None:
            return subject, _PLL_WHY_NONE
        return subject, [
            "`%s` was set from `%s(...)` on line %s, which gave back `None`." % (receiver, set_from["call"], set_from["line"])
        ] + _PLL_WHY_NONE
    # Nothing on the line to point at: name a call, but never a wrapper
    # like `print`, which is not where the value came from.
    named = next(
        (name for name in _pll_src_re.findall(r"([A-Za-z_][\w.]*)\s*\(", e.text or "") if name not in _PLL_WRAPPERS),
        None,
    )
    return ("`%s(...)` gave back `None`" % named if named is not None else unknown), _PLL_WHY_NONE


def _pll_without_joining_space(literal, before):
    """The literal with the space `print` will add for it taken out:
    `print("Next year you will be ", age)` prints two spaces."""
    quote, inner = literal[0], literal[1:-1]
    trimmed = _pll_src_re.sub(r" $", "", inner, count=1) if before else _pll_src_re.sub(r"^ ", "", inner, count=1)
    return quote + trimmed + quote


# -- the rules, in the order they are tried -----------------------------------


@_pll_stock("ModuleNotFoundError", r"^No module named")
def _pll_missing_module(m, e):
    """`No module named 'flask'`, said as why: PLL's Python is Pyodide's,
    whose packages are downloaded before a program runs, from the imports
    PLL can read in it."""
    module = e.facts.get("module")
    if module is None:
        return None
    name, kind = module["name"], module["kind"]
    if kind == "leftOut":
        return "`%s.py` is next to your program, but it was not loaded: %s." % (name, module.get("why")), [
            "A file that was not loaded cannot be imported."
        ]
    if kind == "notLoaded":
        return "`%s` was not loaded before your program ran." % name, [
            "PLL downloads `%s` the first time a program imports it, so this needs the internet once; after that it"
            " is kept. Check the connection, and run the program again." % module.get("package"),
            "PLL loads a package from the `import` lines it reads before the program runs: if this import is made"
            " another way, with a name worked out as it runs, add `import %s` near the top of the file." % name,
        ]
    if kind == "missing":
        return "There is no module called `%s` here." % name, [
            "PLL runs Python with Pyodide, which has many packages - numpy, pandas, matplotlib, requests and more -"
            " but not `%s`." % name,
            "If `%s` is a file of your own, put `%s.py` next to your program." % (name, name),
        ]
    return None


@_pll_stock("TypeError", r"Table|^a table ")
def _pll_builtin_on_table(m, e):
    """`sum(people, "age")`: Python's own `sum`, `min` or `max` given a table
    and a column. A table does that itself."""
    call = _pll_src_re.search(
        r"""\b(sum|min|max|len|sorted)\s*\(\s*([A-Za-z_][\w.]*)\s*,\s*("[^"]*"|'[^']*')\s*\)""", e.text or ""
    )
    if call is None:
        return None
    fn, table, column = call.groups()
    method = "length" if fn == "len" else "order_by" if fn == "sorted" else fn
    return "`%s(%s, %s)` is Python's own `%s`, which knows nothing of tables." % (fn, table, column, fn), [
        "A table does this itself: `%s.%s(%s)`." % (table, method, "" if method == "length" else column)
    ]


@_pll_stock("TypeError", r"not supported between instances of|unsupported operand type")
def _pll_condition_not_function(m, e):
    """`filter("riders" < 1000)` - a condition where a function belongs.

    The comparison is worked out before `filter` is reached, so what Python
    reports is the comparison - accurately, and beside the point. `filter`
    calls a function on each row, and the condition has to be its body.
    """
    line = e.text
    if line is None:
        return None
    tokens = _pll_line_tokens(line)
    for i, token in enumerate(tokens):
        taker = _PLL_FUNCTION_TAKERS.get(token.text)
        if taker is None or "each" not in taker or token.kind != "name" or _pll_text_at(tokens, i + 1) != "(":
            continue
        shut = _pll_closing(tokens, i + 1)
        if shut < 0:
            continue
        inside = tokens[i + 2 : shut]
        # A comparison at the argument's own level, and no `lambda` - which
        # would make it a function after all, anywhere in the argument.
        depth, compares, is_function = 0, False, False
        for part in inside:
            if part.kind == "open":
                depth += 1
            if part.kind == "close":
                depth -= 1
            if depth == 0 and part.text in _PLL_COMPARISONS:
                compares = True
            if part.text == "lambda":
                is_function = True
        if not compares or is_function:
            continue
        name = token.text
        receiver = _pll_text_at(tokens, i - 2) if _pll_text_at(tokens, i - 1) == "." else None
        # A column name compared directly - `"riders" < 1000` - is the text,
        # not the column; inside the function it is `r["riders"]`.
        condition, named = "", None
        cursor = tokens[i + 2].start if i + 2 < len(tokens) else 0
        for k, part in enumerate(inside):
            next_op = inside[k + 1].text if k + 1 < len(inside) else None
            prev_op = inside[k - 1].text if k >= 1 else None
            condition += line[cursor : part.start]
            if part.kind == "str" and name != "transform_column" and (
                next_op in _PLL_COMPARISONS or prev_op in _PLL_COMPARISONS
            ):
                condition += "r[%s]" % part.text
                named = named if named is not None else part.text
            else:
                condition += part.text
            cursor = part.end
        condition = condition.strip()
        call = "%s.%s(keep)" % (receiver, name) if receiver is not None else "%s(keep)" % name
        how_to_fix = [
            "`%s` calls a function on %s and %s, so the condition belongs inside a function. Here it was worked out"
            " first - which is what the error is about." % (name, taker["each"], taker["keeps"]),
            "Write `def keep(%s) -> bool:` with `return %s` as its body, then `%s`." % (taker["param"], condition, call),
        ]
        if named is not None:
            how_to_fix.append("On its own, `%s` is just text. The value in that column of a row is `r[%s]`." % (named, named))
        return "`%s` needs a function, but this gives it a condition." % name, how_to_fix
    return None


@_pll_stock("ValueError", r"^reactor's `(\w+)` has to be a function")
def _pll_handler_called(m, e):
    """A reactor's handler called rather than named: `to_draw=draw_dog(0)`
    has already run `draw_dog` and handed over its picture, so Python
    cannot say which function it was. The student's line still says."""
    line = e.text
    if line is None:
        return None
    handler = m.group(1)
    tokens = _pll_line_tokens(line)
    for i, token in enumerate(tokens):
        if token.text != handler or _pll_text_at(tokens, i + 1) != "=":
            continue
        called = _pll_operand_from(line, tokens, i + 2)
        after = _pll_token(tokens, i + 2)
        fn = after.text if after is not None and after.kind == "name" else None
        if called is None or fn is None or called == fn:
            continue
        return "`%s` has to be given the function itself, not what calling it gives back." % handler, [
            "Write `%s=%s`, not `%s=%s`." % (handler, fn, handler, called),
            "The reactor calls `%s` itself, with its state, every time it needs a picture." % fn,
        ]
    return None


@_pll_stock("TypeError", r"^(\w+)\(\) missing \d+ required positional argument")
def _pll_function_called_not_passed(m, e):
    """`filter(below_1k())` - the function called instead of passed.

    The call happens before `filter` is entered, so what Python reports is
    `below_1k() missing 1 required positional argument: 'r'`, pointing at
    the `def` and mentioning neither `filter` nor the parentheses. Only the
    student's line says which it was.
    """
    line = e.text
    if line is None:
        return None
    name = m.group(1)
    # The empty call has to be *given to* the taker, not merely share a line
    # with it: `filter(below_1k())` or `to_draw=draw()`.
    taker = next(
        (
            candidate
            for candidate in _PLL_CALLS_YOUR_FUNCTION
            if _pll_src_re.search(r"\b%s\b\s*(?:\(|=)\s*(?:[^()]*,\s*)?%s\s*\(\s*\)" % (candidate, name), line)
        ),
        None,
    )
    if taker is None:
        return None
    written = "%s=%s" % (taker, name) if taker in _PLL_HANDLER_KEYWORDS else "%s(%s)" % (taker, name)
    return "`%s` calls `%s` for you, so it needs the function itself." % (taker, name), [
        "Leave the brackets off: `%s`." % written,
        "`%s()` calls it right here, with nothing to work on." % name,
    ]


@_pll_stock("TypeError", r"^(\w+)\(\) takes no arguments")
def _pll_missing_dataclass(m, e):
    """`ITunesSong() takes no arguments`: a class with annotated fields and
    no `@dataclass`. Exactly true and completely unhelpful: the student
    wrote three fields and is told the class takes nothing."""
    class_name = m.group(1)
    fields = _pll_fields_of(e, class_name)
    if fields is None:
        return None
    return "`%s` lists fields (%s) but has no `@dataclass`, so it takes no arguments." % (
        class_name, _pll_list_names(fields)
    ), [
        "Write `@dataclass` on the line above `class %s`." % class_name,
        "Add `from dataclasses import dataclass` at the top of the file if it is not there.",
    ]


@_pll_stock(
    "TypeError",
    r"^(\w+)\.__init__\(\) (?:missing (\d+) required positional argument|takes \d+ positional arguments? but \d+ (?:was|were) given)",
)
def _pll_dataclass_arity(m, e):
    """A dataclass constructed with the wrong number of values. `__init__`
    is the thing to get rid of: the student wrote `ITunesSong(...)` and
    never wrote an `__init__`."""
    class_name = m.group(1)
    fields = _pll_fields_of(e, class_name)
    if fields is None:
        return "`%s` was given the wrong number of values." % class_name, [
            "Give one value for each field of `class %s`, in order." % class_name
        ]
    # Python counts `self`, so "takes 3 but 4 were given" is about 2 fields
    # and 3 values. Both counts are recomputed from the fields.
    given = _pll_src_re.search(r"takes \d+ positional arguments? but (\d+)", e.message)
    got = int(given.group(1)) - 1 if given else max(len(fields) - int(m.group(2)), 0)
    return "`%s` needs %s (%s), but got %d." % (
        class_name, _pll_plural(len(fields), "value"), _pll_list_names(fields), got
    ), ["Give one value for each field, in the order they are written in `class %s`." % class_name]


@_pll_stock("TypeError", r"^(\w+)\(\) missing (\d+) required positional argument")
def _pll_too_few_arguments(m, e):
    """`f() missing 2 required positional arguments: 'a' and 'b'`"""
    name, missing = m.group(1), int(m.group(2))
    # A test function takes no parameters, so pytest has nothing to pass and
    # the test never runs.
    if name.startswith("test_"):
        # Python names the ones missing - all of them, called with nothing.
        named = _pll_src_re.findall(r"'([^']+)'", e.message.split(":", 1)[1]) if ":" in e.message else []
        return "`%s` is a test, so it cannot take any parameters." % name, [
            _pll_test_fix(name, named or _pll_parameters_of(e, name, "required") or [], False, ())
        ]
    check = _pll_arity_check(e, name, "Check the call on this line - one value is needed for each parameter.")
    # Wherever it was defined: the student's file, another of theirs, or
    # PLL's own library.
    names = _pll_parameters_of(e, name, "required")
    if names is None:
        # An imported function from somewhere else: say only what is
        # missing, which Python did name, rather than inventing a total.
        return _pll_needs_more(name, missing, e.message), [check]
    return "`%s` %s, but got %d." % (name, _pll_takes_clause(names, len(names)), max(len(names) - missing, 0)), [
        check
    ] + _pll_library_hint(name)


def _pll_malformed_test_finding(name, parameters, filename, line, unused=()):
    """A `test_*` function with parameters, which the tests do not run: a
    test is called with nothing, so there would be no values for them. Said
    apart from the tests that ran - it is a mistake in how the test is
    written, not a test that failed. `name` is as the report lists it, a
    method's as `TestThings::test_one`; `unused` are the parameters its body
    never reads."""
    function = name.split("::")[-1]
    takes = (
        "a parameter, %s," % _pll_list_names(parameters)
        if len(parameters) == 1
        else "parameters - %s -" % _pll_list_names(parameters)
    )
    return {
        "id": "malformed-test",
        "errorType": "MalformedTest",
        "headline": "`%s` takes %s so it cannot be run as a test." % (function, takes),
        "howToFix": [
            _pll_test_fix(function, parameters, function != name, unused),
            "If it is not a test but a helper your tests use, give it a name that does not start with `test_`.",
        ],
        "fileName": filename,
        "lineNumber": line,
        "column": None,
        "nameToken": function,
        "severity": "error",
        "origin": "runtime",
    }


def _pll_test_fix(function, parameters, method, unused):
    """How a test written with `parameters` is written instead: with empty
    brackets - `self` only, for a method - and examples in its asserts where
    it used the parameters; or, when it used none of them, only the
    brackets. Unknown `parameters` are said as "its parameters"."""
    written = "def %s(self):" % function if method else "def %s():" % function
    if parameters and all(p in unused for p in parameters):
        return "Take %s out of the brackets - `%s` - since the test does not use %s." % (
            _pll_list_names(parameters), written, "it" if len(parameters) == 1 else "them"
        )
    used = [p for p in parameters if p not in unused]
    return "Write `%s`, with %s in the brackets, and use example values in its `assert`s instead of %s." % (
        written, "only `self`" if method else "nothing", _pll_list_names(used) if used else "its parameters"
    )


def _pll_arity_check(e, name, otherwise):
    """What to look at for a wrong number of values: the call on this line,
    or - when a table method made the call - the function's parameters."""
    taker = _PLL_FUNCTION_TAKERS.get(_pll_library_caller(e.frames))
    if taker is None or "param" not in taker:
        return otherwise
    return "%s, so give it one parameter: `def %s(%s):`." % (taker["calls"], name, taker["param"])


@_pll_stock("TypeError", r"^(\w+)\(\) takes (\d+) positional arguments? but (\d+) (?:was|were) given")
def _pll_too_many_arguments(m, e):
    """`f() takes 1 positional argument but 2 were given`"""
    name, takes, given = m.group(1), int(m.group(2)), int(m.group(3))
    # Too many, so the limit is every parameter there is, optional included.
    names = _pll_parameters_of(e, name, "parameters")
    extra = given - (len(names) if names is not None else takes)
    return "`%s` %s, but got %d." % (name, _pll_takes_clause(names, takes), given), [
        _pll_arity_check(
            e,
            name,
            "Check the call on this line - there are %d values too many." % extra
            if extra > 1
            else "Check the call on this line - there is one value too many.",
        )
    ] + _pll_library_hint(name)


@_pll_stock("TypeError", r"^(\w+)\.(\w+)\(\) missing (\d+) required positional argument")
def _pll_method_arity(m, e):
    """A method called with too few arguments. Python names the class
    (`Table.scatter_plot()`), which the student may never have typed."""
    owner, method, missing = m.group(1), m.group(2), int(m.group(3))
    if method == "__init__":
        return None
    required = _pll_parameters_of(e, "%s.%s" % (owner, method), "required")
    if required is None:
        return _pll_needs_more(method, missing, e.message), []
    return "`%s` %s, but got %d." % (
        method, _pll_takes_clause(required, len(required)), max(len(required) - missing, 0)
    ), []


@_pll_stock("AttributeError", r"^type object '(\w+)' has no attribute '(\w+)'")
def _pll_attribute_on_class(m, e):
    """The class used where one of its values was meant - `title(ITunesSong)`
    rather than `title(song)`. "type object" means nothing to a student."""
    class_name, asked = m.groups()
    fields = _pll_fields_of(e, class_name)
    if fields is None:
        return None
    return "`%s` on its own is the class, not one made from it, so it has no `%s`." % (class_name, asked), [
        "`%s(...)` makes one, with a value for each field (%s)." % (class_name, _pll_list_names(fields)),
        "A field belongs to the value, not to the class it was made from.",
    ]


@_pll_stock("AttributeError", r"^'([\w.]+)' object has no attribute '(\w+)'")
def _pll_no_such_attribute(m, e):
    """`'ITunesSong' object has no attribute 'yaer'`"""
    type_name, asked = m.groups()
    name = _pll_last_segment(type_name)
    if name == "NoneType":
        subject, why = _pll_why_none(e, _pll_attribute_receiver(e.text, asked))
        return "%s, so it has no `%s`." % (subject, asked), why
    fields = _pll_fields_of(e, name)
    if fields is None:
        # A class of theirs with no fields - the empty end of a recursive
        # type, like `NoInfo` - has nothing to get, so the value needs
        # checking for before its fields are used.
        if _pll_students_class(e, name):
            return "`%s` has no fields at all, so it has no `%s`." % (name, asked), [
                "A value that might be a `%s` needs a `case %s():` before `.%s` is used." % (name, name, asked)
            ]
        return "A %s has no `%s`." % (_pll_friendly(type_name), asked), []
    suggestion = _pll_closest_name(asked, fields)
    return "`%s` has no field `%s` (its fields are %s)." % (name, asked, _pll_list_names(fields)), (
        ["Did you mean `%s`?" % suggestion] if suggestion is not None else []
    )


@_pll_stock("TypeError", r"^'([\w.]+)' object is not subscriptable")
def _pll_not_subscriptable(m, e):
    """`'ITunesSong' object is not subscriptable`"""
    type_name = m.group(1)
    name = _pll_last_segment(type_name)
    if name == "NoneType":
        subject, why = _pll_why_none(e, _pll_subscript_receiver(e.text))
        return "%s, so square brackets cannot get anything out of it." % subject, why
    method = _pll_src_re.search(r"([A-Za-z_][\w.]*)\.(\w+)\s*\[\s*([^\]]*)\]", e.text or "")
    if name == "method" and method is not None:
        # `people.rows[0]`, `people.row[0]`: a method used as if it were a list.
        holder, called, inside = method.groups()
        return "`%s.%s` is a method, so it is called with round brackets, not indexed with square ones." % (
            holder, called
        ), [
            "Write `%s.row(%s)`: the row number goes in the round brackets." % (holder, inside)
            if called == "row"
            else "Call it first: `%s.%s()[%s]`." % (holder, called, inside)
        ]
    fields = _pll_fields_of(e, name)
    if fields is None:
        # `r["age"]` in a function `transform_column` calls: it is given one
        # value of the column, not the row.
        how_to_fix = []
        if _pll_library_caller(e.frames) == "transform_column":
            how_to_fix.append(
                "%s, so what your function is given is already the value - there is nothing to take out of it."
                % _PLL_FUNCTION_TAKERS["transform_column"]["calls"]
            )
        how_to_fix.append("Square brackets are for lists, dictionaries and table rows.")
        return "Square brackets do not work on a %s." % _pll_friendly(type_name), how_to_fix
    # Their own subscript, turned round: `s["year"]` becomes `s.year`.
    subscript = _pll_src_re.search(r"""([A-Za-z_][\w.]*)\s*\[\s*["'](\w+)["']\s*\]""", e.text or "")
    holder, field = subscript.groups() if subscript else ("value", fields[0])
    return "Square brackets do not get a field out of `%s`." % name, [
        'Use a dot instead: `%s.%s` rather than `%s["%s"]`.' % (holder, field, holder, field),
        "Square brackets are for lists, dictionaries and table rows.",
    ]


@_pll_stock("TypeError", r"^'([\w.]+)' object is not iterable")
def _pll_not_iterable(m, e):
    """`'int' object is not iterable`, almost always `for x in len(xs)`."""
    over = _pll_src_re.search(r"\bfor\s+\w+\s+in\s+len\s*\(\s*([A-Za-z_][\w.]*)\s*\)", e.text or "")
    if over:
        return "`len(%s)` is a number, and a number is not something to loop over." % over.group(1), [
            "To visit each item, write `for item in %s:`." % over.group(1),
            "To count, write `for i in range(len(%s)):` - but the first form is usually what you want." % over.group(1),
        ]
    name = _pll_last_segment(m.group(1))
    if name == "NoneType":
        subject, why = _pll_why_none(e, _pll_looped_over(e.text))
        return "%s, so there is nothing to loop over." % subject, why
    looped = _pll_looped_over(e.text)
    if name == "method" and looped is not None and _pll_src_re.search(r"\.\w+$", looped):
        # `for p in people.rows:` - the method itself, not the rows it gives.
        return "`%s` is the method itself, not what it gives back - it has not been called." % looped, [
            "Call it, with brackets: `for ... in %s():`." % looped
        ]
    return "A %s is not something to loop over." % _pll_friendly(m.group(1)), [
        "`for` needs a list, a string, a range or something else with items in it."
    ]


@_pll_stock("TypeError", r'can only concatenate (str|list|tuple) \(not "([\w.]+)"\) to \1')
def _pll_concat_mismatch(m, e):
    """`can only concatenate str (not "int") to str`, and the same for lists
    and tuples. For a string the question is which side to convert; for a
    list it is almost always one item that belongs in brackets."""
    container, other = m.groups()
    headline = "A %s and a %s cannot be added together." % (_pll_friendly(container), _pll_friendly(other))
    line = e.text or ""
    if container == "str":
        # Built from the line when its two operands can be read: a string
        # literal on one side of the `+` and an expression on the other.
        pair = _pll_concat_operands(line)
        how_to_fix = []
        if pair is not None:
            text, value, text_first = pair
            how_to_fix.append(
                "To join them as text, convert `%s` with `str`: `%s`."
                % (value, "%s + str(%s)" % (text, value) if text_first else "str(%s) + %s" % (value, text))
            )
            if _pll_src_re.match(r"\s*print\s*\(", line):
                spaced = _pll_without_joining_space(text, text_first)
                how_to_fix.append(
                    "In `print`, a comma needs no conversion at all, and puts a space in for you: `print(%s)`."
                    % ("%s, %s" % (spaced, value) if text_first else "%s, %s" % (value, spaced))
                )
        else:
            # `age + 1` where `age = input(...)`: the text is a number someone
            # typed, and adding to it is the point - so converting it comes
            # first, and joining as text is not the advice at all.
            typed = _pll_typed_operand(line, e.facts)
            if typed is not None:
                return headline, [
                    "`%s` came from `input`, which always gives back text - even when a number is typed." % typed[0],
                    "Convert it first: `%s`." % typed[1],
                ]
            how_to_fix += [
                "To join them as text, convert the other value with `str(...)`.",
                "In `print`, separate them with commas instead, which needs no conversion.",
            ]
        how_to_fix.append("To add them as numbers instead, convert the text with `int(...)` or `float(...)`.")
        return headline, how_to_fix
    # A list (or tuple) and one value: `xs + "!"`. What was meant is nearly
    # always that one value as a new item.
    operand = _pll_src_re.search(r"([A-Za-z_][\w.]*)\s*\+", line)
    named = operand.group(1) if operand else "xs"
    opening, closing = ("[", "]") if container == "list" else ("(", ",)")
    how_to_fix = [
        "`+` joins a %s to another %s. To add one item, put it inside %s: `%s + %sitem%s`."
        % (container, container, "brackets" if container == "list" else "a tuple", named, opening, closing)
    ]
    if container == "list":
        how_to_fix.append(
            "Or add it in place with `%s.append(item)`, which changes `%s` and returns nothing." % (named, named)
        )
    return headline, how_to_fix


@_pll_stock("TypeError", r"^unsupported operand type\(s\) for (\S+?): '([\w.]+)' and '([\w.]+)'")
def _pll_operand_mismatch(m, e):
    """`unsupported operand type(s) for +: 'NoneType' and 'int'`"""
    operator, left, right = m.groups()
    if left != "NoneType" and right != "NoneType":
        return "`%s` does not work between a %s and a %s." % (operator, _pll_friendly(left), _pll_friendly(right)), (
            ["Convert one of them first - `int(...)` for a number, `str(...)` for text."]
            if (left == "str") != (right == "str")
            else []
        )
    # The usual cause: a function that changes something rather than
    # returning it, used as though it returned.
    side = "left" if left == "NoneType" else "right"
    subject, why = _pll_why_none(e, _pll_operand_beside(e.text, operator, side), "One of these values is `None`")
    return "%s, so `%s` cannot be used on it." % (subject, operator), why


@_pll_stock("TypeError", r"^'(\S+)' not supported between instances of '([\w.]+)' and '([\w.]+)'")
def _pll_comparison_mismatch(m, e):
    """`'<' not supported between instances of 'str' and 'int'`. The advice
    has to come from the types in hand: a fixed example such as
    `int("999")` would fit only some of the comparisons it is shown for."""
    operator, left, right = m.groups()
    text = left if left == "str" else right if right == "str" else None
    number = next(
        (_pll_last_segment(t) for t in (left, right) if _pll_last_segment(t) in ("int", "float")), None
    )
    if text is not None and number is not None:
        # The one case with an actual choice to offer: which side to convert.
        how_to_fix = [
            "Convert the text to a number with `%s(...)`, or the number to text with `str(...)` - whichever this"
            " comparison is meant to be about." % number
        ]
    else:
        how_to_fix = ["`%s` only orders values of the same kind; there is no answer to this comparison." % operator]
    return "`%s` cannot compare a %s with a %s." % (operator, _pll_friendly(left), _pll_friendly(right)), how_to_fix


@_pll_stock("ValueError", r"^invalid literal for int\(\) with base 10: (.+)$")
def _pll_bad_int_literal(m, e):
    """`invalid literal for int() with base 10: 'nineteen'`. Nothing typed
    and a word typed are different mistakes, and when the text came from
    `input` on this line, the line says so."""
    raw = m.group(1).strip()
    empty = raw in ("''", '""')
    # Python prints the repr, `'nineteen'`; the course writes `"nineteen"`.
    shown = '"%s"' % raw[1:-1] if _pll_src_re.fullmatch(r"'[^'\"]*'", raw) else raw
    how_to_fix = ['`int` only reads whole numbers written in digits, like `"19"`.']
    if _pll_src_re.search(r"\binput\s*\(", e.text or ""):
        how_to_fix.append(
            "Nothing was typed: pressing Enter on its own makes `input` give back an empty string."
            if empty
            else "`input` gives back exactly what was typed, as text, so a word cannot become a number."
        )
    if empty:
        return "`int` cannot turn an empty string into a whole number.", how_to_fix
    return "`int` cannot turn %s into a whole number." % shown, how_to_fix


@_pll_stock("IndexError", r"index out of range")
def _pll_index_range(m, e):
    """`list index out of range`"""
    subscript = _pll_src_re.search(r"([A-Za-z_][\w.]*)\s*\[\s*([^\]]+?)\s*\]", e.text or "")
    # Python read the real length from the frame; a made-up "list of 3"
    # read as a claim about theirs.
    sequence, length = e.facts.get("sequence"), e.facts.get("length")
    if sequence is not None and length is not None:
        return "`%s` has no item at that position." % sequence, [
            "`%s` is empty, so it has no items at all." % sequence
            if length == 0
            else "`%s` has %d item%s, numbered 0 to %d - positions start at 0."
            % (sequence, length, "" if length == 1 else "s", length - 1)
        ]
    named = "`%s`" % subscript.group(1) if subscript else "This list"
    return "%s has no item at that position." % named, [
        "Positions start at 0, so the last item of a list is at position `len(...) - 1`.",
        "`len(%s)` gives the number of items." % subscript.group(1) if subscript else "`len(...)` gives the number of items.",
    ]


@_pll_stock("TypeError", r"^'([\w.]+)' object is not callable")
def _pll_not_callable(m, e):
    """`'int' object is not callable`, usually a missing `*`."""
    if m.group(1) == "types.UnionType":
        # `types.UnionType` is an implementation name for `Boa | Armadillo`.
        called = _pll_call_on(e.text)
        members = _pll_union_members_of(e, called) if called is not None else None
        return (
            "`%s` is a union of several types, not something to make one of." % called
            if called is not None
            else "This is a union of several types, not something to make one of."
        ), (
            ["Make one of %s instead, like `%s(...)`." % (_pll_list_names(members), members[0])]
            if members is not None
            else ["Make one of the types the union is built from."]
        )
    # `3(width)` - a number followed by brackets is nearly always a missing
    # `*`. Python's own "perhaps you missed a comma?" points elsewhere.
    juxtaposed = _pll_src_re.search(r"(\d+(?:\.\d+)?)\s*\(([^()]*)\)", e.text or "")
    if juxtaposed and _pll_last_segment(m.group(1)) in ("int", "float"):
        written, number, inside = juxtaposed.group(0), juxtaposed.group(1), juxtaposed.group(2)
        return "Brackets after `%s` look like a function call, not multiplication." % number, [
            "To multiply, write the `*`: `%s * %s`, not `%s`." % (number, inside.strip() or "...", written)
        ]
    return "A %s cannot be called like a function." % _pll_friendly(m.group(1)), [
        "Brackets after a value mean a call; check whether a `*` or a comma is missing."
    ]


@_pll_stock("TypeError", r"^(\w+)\(\) accepts (\d+) positional sub-patterns \((\d+) given\)")
def _pll_pattern_arity(m, e):
    """`Boa() accepts 2 positional sub-patterns (3 given)`"""
    class_name, accepts, given = m.group(1), int(m.group(2)), m.group(3)
    fields = _pll_fields_of(e, class_name)
    return "`%s` has %s%s, but this pattern names %s." % (
        class_name, _pll_plural(accepts, "field"), " (%s)" % _pll_list_names(fields) if fields is not None else "", given
    ), (
        ["Write one name for each field: `case %s(%s):`." % (class_name, ", ".join(fields))]
        if fields is not None
        else ["Write one name for each field, in order."]
    )


@_pll_stock("TypeError", r"list indices must be integers or slices, not tuple")
def _pll_missing_comma(m, e):
    """Two lists written next to each other with no comma between them -
    `[["Jan", 1] ["Feb", 2]]` - which Python reads as looking something up
    in the first one."""
    return "A comma is missing between two values in a list.", [
        "`[a, b] [c, d]` with no comma reads as looking `c, d` up inside the first list.",
        "Write `[[a, b], [c, d]]`, with a comma after every row.",
    ]


@_pll_stock("RecursionError", r"maximum recursion depth")
def _pll_recursion_depth(m, e):
    """`maximum recursion depth exceeded`: the repeated frame is the
    function that never got smaller, repeated hundreds of times."""
    counts = {}
    for frame in e.frames:
        if frame["function"] is not None:
            counts[frame["function"]] = counts.get(frame["function"], 0) + 1
    best, best_count = None, 0
    for name, count in counts.items():
        if count > best_count:
            best, best_count = name, count
    named = "`%s`" % best if best_count >= 3 else "A function"
    return "%s kept calling itself and never stopped." % named, [
        "Each call has to work on something smaller - the rest of the list, a smaller number.",
        "Check that there is a case that returns without calling again, and that it is reached.",
    ]


@_pll_stock("ValueError", r"All arrays must be of the same length")
def _pll_uneven_columns(m, e):
    """pandas' `All arrays must be of the same length`, for a DataFrame's dict."""
    how_to_fix = [
        "Each list in the dictionary is one column, and every column needs one value for each row - so the lists"
        " have to be the same length."
    ]
    if _pll_src_re.search(r"DataFrame\s*\(", e.text or ""):
        how_to_fix.append("Count the values in each list on this line; one has more or fewer than the rest.")
    return "The columns of this DataFrame have different numbers of values.", how_to_fix


@_pll_stock("KeyError", r"^\s*'[\s\S]*'\s*$")
def _pll_pandas_key_error(m, e):
    """pandas `KeyError: 'ratings'`, raised deep inside pandas' indexing."""
    # A frame inside the installed library, not merely the word "pandas":
    # `samples/pandas.py` is a real file, and a plain dict `KeyError` in it
    # is not a missing DataFrame column.
    inside = any(
        _pll_src_re.search(r"[/\\]pandas[/\\]core[/\\]|site-packages[/\\]pandas", frame["file"] or "")
        for frame in e.frames
    )
    if not inside:
        return None
    key = _pll_src_re.fullmatch(r"'([\s\S]*)'", e.message.strip())
    if key is None:
        return None
    frame = _pll_src_re.search(r"([A-Za-z_][\w.]*)\s*\[", e.text or "")
    return "There is no column named `%s`." % key.group(1), [
        "`print(%s.columns)` lists the columns this DataFrame has." % frame.group(1)
        if frame
        else "`.columns` lists the columns a DataFrame has.",
        "Column names are case-sensitive, and spaces count.",
    ]
