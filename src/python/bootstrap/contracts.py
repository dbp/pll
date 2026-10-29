# Annotations as contracts, with the semantics of Findler and Felleisen's
# λCON ("Contracts for Higher-Order Functions", ICFP 2002) and Racket's
# first-order checks on functions. docs/contracts.md has the design.
#
# A definition's annotations are its contract, and every reference to a
# contracted function is an obligation between two parties: the definition
# itself, and the definition the reference is in. A flat contract is checked
# when its value crosses. A function contract is checked first-order when the
# function crosses, and in full at each application: the argument with the
# parties swapped, the result as they are. A failed check blames the party
# that, by those rules, gave the value. compile.py puts the obligations into
# a program, and explain/typeCheck.py words a broken one.

import collections as _pll_collections
import collections.abc as _pll_abc
import dataclasses as _pll_dataclasses
import inspect as _pll_inspect
import sys as _sys
import types as _pll_types
import typing as _pll_typing
import weakref as _pll_weakref


# -- parties and blame -------------------------------------------------------


class _PllParty:
    """One side of an obligation: a definition. `kind` is "function" - a
    `def`, a method or a test - or "main", the top level of a file or a
    prompt line. `name` is how a message names it (`outer.inner`,
    `Dog.bark`); `qualname` is its code's, by which a frame is matched to it.
    """

    __slots__ = ("kind", "name", "qualname", "file", "line")

    def __init__(self, kind, name, qualname, file, line):
        self.kind = kind
        self.name = name
        self.qualname = qualname
        self.file = file
        self.line = line

    def owns(self, code):
        """Whether `code` runs as part of this definition: its own body, or a
        lambda or generator expression in it - not a `def` inside it, which
        is a definition of its own."""
        if code.co_filename != self.file:
            return False
        qualname = code.co_qualname
        if self.kind == "main":
            return qualname.startswith("<")
        return qualname == self.qualname or qualname.startswith(self.qualname + ".<locals>.<")

    def fact(self):
        return {"kind": self.kind, "name": self.name, "file": _pll_shown_file(self.file), "line": self.line}


#: Parties by the description compile.py writes into the program:
#: `(kind, name, qualname, file, line)`.
_PLL_PARTIES = {}


def _pll_party(spec):
    party = _PLL_PARTIES.get(spec)
    if party is None:
        party = _PLL_PARTIES[spec] = _PllParty(*spec)
    return party


def _pll_party_of_code(code):
    """The definition `code` runs as part of, where no reference says - the
    code that called a method, say. A lambda or a generator expression is
    part of the definition it is written in."""
    qualname = code.co_qualname.split(".<locals>.<")[0]
    if qualname.startswith("<"):
        return _pll_party(("main", None, "<module>", code.co_filename, None))
    name = qualname.replace(".<locals>.", ".")
    line = code.co_firstlineno if qualname == code.co_qualname else None
    return _pll_party(("function", name, qualname, code.co_filename, line))


class _PllBlame:
    """Who answers for a check. `positive` gave the value and `negative` took
    it; `owner` is the definition whose contract it is, `path` the steps from
    that contract to this check, and `site` where the obligation was made -
    the reference, as `(file, line, column)` - or None where nothing
    referred to the function (a method, called through its object).

    A step is a tuple whose first item says what it is - `("argument",
    name, index, written)`, `("result", returned_at, written)`, `("item",
    index)` - and whose last-but-structure is what a message needs.
    """

    __slots__ = ("positive", "negative", "owner", "path", "site", "level")

    def __init__(self, positive, negative, owner, path=(), site=None, level=None):
        self.positive = positive
        self.negative = negative
        self.owner = owner
        self.path = path
        self.site = site
        # The level of the file the contract is written in, which decides
        # how strictly it was checked.
        self.level = level

    def swapped(self, step):
        """For a function's argument: whoever took the function gives it."""
        return _PllBlame(self.negative, self.positive, self.owner, self.path + (step,), self.site, self.level)

    def into(self, step):
        """For a part of the value - an item, a field, a result: the same giver."""
        return _PllBlame(self.positive, self.negative, self.owner, self.path + (step,), self.site, self.level)


# -- what is raised ------------------------------------------------------------


class _PllTypeMismatch(Exception):
    """A value that broke its contract. All an explanation needs is in its
    facts (`check`); the message is only what is shown if nothing explains it."""


class _PllNotAType(Exception):
    """An annotation that is not a type: found when its `def` ran - or, for a
    name in quotes, when the name was first looked up."""


# Shown as Python shows its own exceptions: no module, no PLL in the name.
for _pll_shown_as, _pll_exception in (("TypeMismatch", _PllTypeMismatch), ("NotAType", _PllNotAType)):
    _pll_exception.__name__ = _pll_exception.__qualname__ = _pll_shown_as
    _pll_exception.__module__ = "builtins"


# -- contracts -----------------------------------------------------------------


class _PllContract:
    """What an annotation promises.

    - `accepts(value)`: what can be decided at once - all of it for a flat
      contract; for a function's, Racket's first-order check.
    - `check_now(value, blame)`: the same, raising where the value failed -
      at the deepest part, for a container.
    - `check(value, blame)`: the value as it may cross: a function wrapped,
      so the rest is checked at each of its calls.

    `written` is the annotation as the program wrote it.
    """

    flat = True

    def __init__(self, written):
        self.written = written

    def is_flat(self):
        """`flat`, worked out once - for a union or a name in quotes, from
        what they turn out to be."""
        known = self.__dict__.get("_flat")
        if known is None:
            known = self.__dict__["_flat"] = bool(self.flat)
        return known

    def accepts(self, value):
        return True

    def check_now(self, value, blame):
        if not self.accepts(value):
            _pll_broken(self, value, blame)

    def check(self, value, blame):
        self.check_now(value, blame)
        return value

    def expected(self):
        """The types a message says were wanted."""
        return [self.written]

    def shaped(self, value):
        """Whether `value` is the kind of thing this contract is about - the
        class, the container - whatever is inside it. A union whose one
        such member rejects the value says where inside it went wrong."""
        return False


class _PllAnyContract(_PllContract):
    def check(self, value, blame):
        return value


class _PllNoneContract(_PllContract):
    def accepts(self, value):
        return value is None

    def expected(self):
        return ["None"]


class _PllClassContract(_PllContract):
    """`isinstance`, with PEP 484's numeric tower - an `int` is a `float` -
    and, at the teaching levels, no `bool` where a number is annotated:
    Python counts `True` as 1, and a student who annotates `int` and passes
    `True` has almost always made a mistake."""

    def __init__(self, cls, written, level):
        super().__init__(written)
        self.cls = cls
        self.no_bools = level in _PLL_TEACHING_LEVELS and cls in (int, float, complex)

    def accepts(self, value):
        cls = self.cls
        if cls is float:
            fits = isinstance(value, (int, float))
        elif cls is complex:
            fits = isinstance(value, (int, float, complex))
        else:
            fits = isinstance(value, cls)
        return fits and not (self.no_bools and isinstance(value, bool))

    def shaped(self, value):
        return isinstance(value, self.cls)

    def expected(self):
        return [_pll_type_text(self.cls)]


class _PllLiteralContract(_PllContract):
    """`Literal["red", "green"]`: one of those values, of the same type -
    `True` is not `Literal[1]`."""

    def __init__(self, values, written):
        super().__init__(written)
        self.values = values

    def accepts(self, value):
        return any(type(value) is type(v) and value == v for v in self.values)


class _PllNeverContract(_PllContract):
    """`NoReturn`: nothing comes back at all."""

    def accepts(self, value):
        return False


class _PllUnionContract(_PllContract):
    """Racket's `or/c`: a flat member that accepts the value, or else the
    one higher-order member whose first-order check does. Two that both
    could is no answer, and the contract cannot be used."""

    def __init__(self, members, written):
        super().__init__(written)
        self.members = members

    @property
    def flat(self):
        return all(member.flat for member in self.members)

    def accepts(self, value):
        return any(member.accepts(value) for member in self.members)

    def check(self, value, blame):
        higher = []
        for member in self.members:
            if member.flat:
                if member.accepts(value):
                    return value
            elif member.accepts(value):
                higher.append(member)
        if len(higher) == 1:
            return higher[0].check(value, blame)
        if higher:
            _pll_not_a_type(
                "ambiguous", self.written, blame.owner, blame.path[:1],
                members=[member.written for member in higher],
            )
        self.check_now(value, blame)

    def check_now(self, value, blame):
        if self.accepts(value):
            return
        shaped = [member for member in self.members if member.shaped(value)]
        if len(shaped) == 1:
            shaped[0].check_now(value, blame)
        _pll_broken(self, value, blame)

    def shaped(self, value):
        return any(member.shaped(value) for member in self.members)

    def expected(self):
        return [text for member in self.members for text in member.expected()]


class _PllItemsContract(_PllContract):
    """`list[T]`, `set[T]` and their kind: the container and every item in
    it, checked as it crosses. A function among the items is checked
    first-order only - the container is shared, and wrapping an item would
    mean copying it - and a change made to the container later is not
    checked at all."""

    def __init__(self, kind, item, written, ordered):
        super().__init__(written)
        self.kind = kind
        self.item = item
        self.ordered = ordered

    def shaped(self, value):
        return isinstance(value, self.kind)

    def accepts(self, value):
        return isinstance(value, self.kind) and all(self.item.accepts(item) for item in value)

    def check_now(self, value, blame):
        if not isinstance(value, self.kind):
            _pll_broken(self, value, blame)
        holder = _pll_type_name(value)
        for index, item in enumerate(value):
            if not self.item.accepts(item):
                self.item.check_now(item, blame.into(("item", index, holder) if self.ordered else ("member", holder)))

    def expected(self):
        return [self.written]


class _PllMappingContract(_PllContract):
    """`dict[K, V]`: every key and every value, as the dictionary crosses."""

    def __init__(self, kind, key, value, written):
        super().__init__(written)
        self.kind = kind
        self.key = key
        self.value = value

    def shaped(self, value):
        return isinstance(value, self.kind)

    def accepts(self, value):
        return isinstance(value, self.kind) and all(
            self.key.accepts(k) and self.value.accepts(v) for k, v in value.items()
        )

    def check_now(self, value, blame):
        if not isinstance(value, self.kind):
            _pll_broken(self, value, blame)
        holder = _pll_type_name(value)
        for key, item in value.items():
            if not self.key.accepts(key):
                self.key.check_now(key, blame.into(("key", key, holder)))
            if not self.value.accepts(item):
                self.value.check_now(item, blame.into(("value", key, holder)))


class _PllTupleContract(_PllContract):
    """`tuple[int, str]`, so many items of their own types, or `tuple[int,
    ...]`, any number of one."""

    def __init__(self, items, written, repeated):
        super().__init__(written)
        self.items = items
        self.repeated = repeated

    def _parts(self, value):
        if self.repeated:
            return zip(value, [self.items[0]] * len(value))
        return zip(value, self.items)

    def _shaped(self, value):
        return isinstance(value, tuple) and (self.repeated or len(value) == len(self.items))

    def shaped(self, value):
        return self._shaped(value)

    def accepts(self, value):
        return self._shaped(value) and all(contract.accepts(item) for item, contract in self._parts(value))

    def check_now(self, value, blame):
        if not self._shaped(value):
            _pll_broken(self, value, blame)
        for index, (item, contract) in enumerate(self._parts(value)):
            if not contract.accepts(item):
                contract.check_now(item, blame.into(("item", index, "tuple")))


class _PllClassOfContract(_PllContract):
    """`type[Dog]`: the class itself, or one made from it."""

    def __init__(self, cls, written):
        super().__init__(written)
        self.cls = cls

    def accepts(self, value):
        return isinstance(value, type) and (self.cls is None or issubclass(value, self.cls))


#: The `(id(value), id(contract))` checks under way, which a value that
#: contains itself must not start again.
_PLL_CHECKING = set()


class _PllDataContract(_PllContract):
    """A generic dataclass with its type filled in, `Leaf[float]`: the class,
    and every field with `T` as `float`. Through a field that names the type
    again (`left: "BinTree[T]"`), a whole tree is checked to its leaves.
    `fields` gives `{name: contract}`, and is asked once, when first needed."""

    def __init__(self, cls, fields, written):
        super().__init__(written)
        self.cls = cls
        self._fields = fields
        self._made = None

    def fields(self):
        if self._made is None:
            self._made = self._fields()
        return self._made

    def _each(self, value, test):
        key = (id(value), id(self))
        if key in _PLL_CHECKING:
            return True
        _PLL_CHECKING.add(key)
        try:
            return test()
        finally:
            _PLL_CHECKING.discard(key)

    def shaped(self, value):
        return isinstance(value, self.cls)

    def accepts(self, value):
        return isinstance(value, self.cls) and self._each(
            value,
            lambda: all(contract.accepts(getattr(value, name, None)) for name, contract in self.fields().items()),
        )

    def check_now(self, value, blame):
        if not isinstance(value, self.cls):
            _pll_broken(self, value, blame)

        def each():
            for name, contract in self.fields().items():
                field = getattr(value, name, None)
                if not contract.accepts(field):
                    contract.check_now(field, blame.into(("part", name, self.cls.__name__)))
            return True

        self._each(value, each)


class _PllLaterContract(_PllContract):
    """A contract made when first needed: a name in quotes, or a type alias,
    either of which may name something the file defines further down."""

    def __init__(self, make, written):
        super().__init__(written)
        self._make = make
        self._made = None

    def made(self):
        if self._made is None:
            self._made = self._make()
        return self._made

    @property
    def flat(self):
        return self.made().flat

    def accepts(self, value):
        return self.made().accepts(value)

    def check_now(self, value, blame):
        self.made().check_now(value, blame)

    def check(self, value, blame):
        return self.made().check(value, blame)

    def expected(self):
        return self.made().expected()

    def shaped(self, value):
        return self.made().shaped(value)


class _PllFunctionContract(_PllContract):
    """A function's contract. From a `def`, `params` are its parameters as
    `(name, kind, contract, written)` and `signature` binds a call to them;
    from `Callable[[A, B], R]` they are two positional ones without names,
    and from `Callable[..., R]` there are none to check (`params` is None).

    Racket's `->` checks a function first-order as it crosses - callable,
    taking that many arguments - and the rest at each call. `code` is the
    `def`'s own, whose `return` lines are noted for the result's check.
    """

    flat = False

    def __init__(self, params, result, written, signature=None, code=None):
        super().__init__(written)
        self.params = params
        self.result = result
        self.signature = signature
        self.code = code
        if signature is not None:
            self.positional = [
                (contract, ("argument", name, index, written))
                for index, (name, kind, contract, written) in enumerate(params)
                if kind in (_pll_inspect.Parameter.POSITIONAL_ONLY, _pll_inspect.Parameter.POSITIONAL_OR_KEYWORD)
            ]
            self.binds_simply = all(p[1] != _pll_inspect.Parameter.VAR_POSITIONAL for p in params)
        elif params is not None:
            self.positional = [
                (contract, ("argument", None, index, written)) for index, (_name, _kind, contract, written) in enumerate(params)
            ]

    def contract(self):
        return self

    def accepts(self, value):
        if not callable(value):
            return False
        if self.params is None or self.signature is not None:
            return True
        return _pll_takes(value, len(self.params))

    def check(self, value, blame):
        self.check_now(value, blame)
        return _pll_wrapped(value, self, blame)

    def check_arguments(self, args, kwargs, blame):
        """A call's arguments, each as its parameter's contract gives it back.
        A call that does not fit the parameters is left alone, for Python to
        say what is wrong with it."""
        params = self.params
        if params is None:
            return args, kwargs
        if self.signature is None:
            if kwargs or len(args) != len(params):
                return args, kwargs
            return _pll_checked_positionally(args, self.positional, blame), kwargs
        if not kwargs and self.binds_simply and len(args) <= len(self.positional):
            return _pll_checked_positionally(args, self.positional, blame), kwargs
        try:
            bound = self.signature.bind(*args, **kwargs)
        except TypeError:
            return args, kwargs
        for index, (name, kind, contract, written) in enumerate(params):
            if name not in bound.arguments:
                continue
            given = bound.arguments[name]
            if kind == _pll_inspect.Parameter.VAR_POSITIONAL:
                bound.arguments[name] = tuple(
                    contract.check(arg, blame.swapped(("argument", name, index + at, written)))
                    for at, arg in enumerate(given)
                )
            elif kind == _pll_inspect.Parameter.VAR_KEYWORD:
                bound.arguments[name] = {
                    key: contract.check(arg, blame.swapped(("argument", key, None, written)))
                    for key, arg in given.items()
                }
            else:
                bound.arguments[name] = contract.check(given, blame.swapped(("argument", name, index, written)))
        return bound.args, bound.kwargs


def _pll_checked_positionally(args, positional, blame):
    """Positional arguments, each checked by its parameter's contract with the
    parties swapped. A value a flat contract accepts is the value itself,
    and needs no blame made for it: that is all but the failures."""
    checked = None
    for index, arg in enumerate(args):
        contract, step = positional[index]
        if contract.is_flat():
            if not contract.accepts(arg):
                contract.check_now(arg, blame.swapped(step))
            continue
        given = contract.check(arg, blame.swapped(step))
        if given is not arg:
            if checked is None:
                checked = list(args)
            checked[index] = given
    return args if checked is None else tuple(checked)


def _pll_takes(function, count):
    """Whether `function` can be called with `count` positional arguments - so
    far as Python can say; a built-in it cannot say about is let through."""
    try:
        signature = _pll_inspect.signature(function)
    except (TypeError, ValueError):
        return True
    try:
        signature.bind(*range(count))
    except TypeError:
        return False
    return True


# -- functions under contract ----------------------------------------------------


#: What a wrapper shows of the function it wraps, as `functools.wraps`
#: copies: so `f.__annotations__` and `help(f)` see the function's own.
_PLL_WRAPPER_ASSIGNMENTS = ("__module__", "__name__", "__qualname__", "__doc__", "__annotations__", "__type_params__")


class _PllCall:
    """A call of a contracted function that is running: its `def`'s code,
    and the line of the `return` that ended it."""

    __slots__ = ("code", "returned_at")

    def __init__(self, code):
        self.code = code
        self.returned_at = None


#: The calls of contracted functions under way, innermost last.
_PLL_CALLS = []


class _PllReturnedFrom:
    """A function that returned a value its contract refused, standing in
    for its frame, which has gone: its code, its globals, and a line in it -
    the `return`, or its last line when it ran off its end."""

    def __init__(self, code, function, line):
        self.f_code = code
        self.f_globals = getattr(function, "__globals__", None) or {}
        self.f_locals = {}
        self.f_builtins = vars(_pll_builtins)
        self.f_lineno = line if line is not None else max(
            (end for _start, _stop, end in code.co_lines() if end is not None), default=code.co_firstlineno
        )


def _pll_wrapped(function, source, blame):
    """`function` under the contract `source` gives, between `blame`'s parties:
    each call's arguments checked as the caller's - the parties swapped - and
    its result as the function's own.

    `source` is a function contract, or a definition, which makes its
    contract at the first call: a name in quotes in its annotations may be
    defined after the function is.
    """

    def contracted(*args, **kwargs):
        contract = source.contract()
        try:
            args, kwargs = contract.check_arguments(args, kwargs, blame)
        except _PllUnresolved as unresolved:
            _pll_unresolved_inside(unresolved, blame)
        call = _PllCall(contract.code)
        _PLL_CALLS.append(call)
        try:
            result = function(*args, **kwargs)
        finally:
            _PLL_CALLS.pop()
        wanted = contract.result
        try:
            if wanted.is_flat() and wanted.accepts(result):
                return result
            return wanted.check(result, blame.into(("result", call.returned_at, wanted.written)))
        except _PllUnresolved as unresolved:
            _pll_unresolved_inside(unresolved, blame)
        except _PllTypeMismatch as error:
            if contract.code is not None:
                # The function has returned; how it is built is still worth
                # reading (`_pll_code_facts`).
                error._pll_returned_from = _PllReturnedFrom(contract.code, function, call.returned_at)
            raise

    for attribute in _PLL_WRAPPER_ASSIGNMENTS:
        try:
            setattr(contracted, attribute, getattr(function, attribute))
        except (AttributeError, TypeError):
            pass
    # So `inspect.signature` sees the function's own parameters - even
    # asked not to look through a wrapper, as finding a test's are.
    contracted.__wrapped__ = function
    if isinstance(source, _PllDefinition):
        contracted.__signature__ = source.signature
    return contracted


def _pll_unresolved_inside(unresolved, blame):
    """A name in quotes inside an annotation - `list["Dog"]` - looked up at
    its first check and found to name nothing: the annotation's fault."""
    _pll_not_a_type(unresolved.reason, unresolved.name, blame.owner, ("annotation", None), missing=unresolved.name)


def _pll_returning(value, line):
    """What a `return` gives back, with its line noted for its call's check -
    if the call is one a wrapper is watching."""
    if _PLL_CALLS:
        call = _PLL_CALLS[-1]
        if call.code is _sys._getframe(1).f_code:
            call.returned_at = line
    return value


class _PllDefinition:
    """An annotated `def`: whose it is (`party`), how its annotations were
    written (`written`, by parameter, with "return"), which were written in
    quotes (`quoted`), and the contract they make - made at its first call."""

    def __init__(self, function, party, written, quoted, level):
        self.function = function
        self.party = party
        self.written = written
        self.quoted = quoted
        self.level = level
        self.code = function.__code__
        self.signature = _pll_inspect.signature(function)
        self._contract = None

    def annotations(self):
        return getattr(self.function, "__annotations__", None) or {}

    def validate(self):
        """Refuse an annotation that is no type, while the `def` runs. A name
        in quotes is looked up later, when it may have been defined."""
        for name, annotation in self.annotations().items():
            if name in self.quoted:
                continue
            reason = _pll_why_not_a_type(annotation)
            if reason is not None:
                _pll_not_a_type(
                    reason, self.written.get(name, _pll_type_text(annotation)), self.party,
                    (("result" if name == "return" else "argument"), name),
                    value=annotation,
                )

    def contract(self):
        if self._contract is None:
            self._contract = self._make()
        return self._contract

    def _make(self):
        hints = self.annotations()
        namespace = self.function.__globals__

        def made(name):
            if name not in hints:
                return _PLL_ANY
            written = self.written.get(name)
            try:
                return _pll_compile(hints[name], written, namespace, self.level, forced=True)
            except _PllUnresolved as unresolved:
                _pll_not_a_type(
                    unresolved.reason, written or _pll_type_text(hints[name]), self.party,
                    (("result" if name == "return" else "argument"), name),
                    missing=unresolved.name,
                )

        signature = self.signature
        params = [
            (p.name, p.kind, made(p.name), self.written.get(p.name, "")) for p in signature.parameters.values()
        ]
        result = made("return")
        return _PllFunctionContract(
            params, result, self.written.get("return", ""), signature=signature, code=self.code
        )


_PLL_ANY = _PllAnyContract("Any")

#: The definition behind each contracted function's boundary (`_pll_boundary`).
_PLL_BOUNDARIES = _pll_weakref.WeakKeyDictionary()


def _pll_ref(value, party, line, column):
    """A reference, from the definition `party` at `line`, to what may be a
    contracted function: the obligation between them, if it is one - made
    on the function itself, so its boundary does not check the call again.

    A boundary keeps the obligations made at each reference to it
    (`__pll_obligations__`), one per `(party, line, column)`, so evaluating
    a reference twice gives the same function both times. The dict says
    whose it is under `None`: a decorator's `functools.wraps` copies it onto
    the function it makes, which is not the boundary, and is left alone.
    """
    made = getattr(value, "__pll_obligations__", None)
    if made is None or made.get(None) is not value:
        return value
    key = (party, line, column)
    wrapper = made.get(key)
    if wrapper is None:
        definition = _PLL_BOUNDARIES[value]
        taker = _pll_party(party)
        blame = _PllBlame(
            definition.party, taker, definition.party, (), (taker.file, line, column), definition.level
        )
        wrapper = made[key] = _pll_wrapped(definition.function, definition, blame)
    return wrapper


def _pll_boundary(function, definition):
    """What a contracted `def`'s name is given: the function under its
    contract for code that reaches it with no reference of its own to make
    the obligation - a method, called through its object; a file at `#level
    raw` calling into one that checks. Each call makes the obligation with
    the code that made it, as Racket's module boundary does with whoever
    imports what it provides."""

    def contracted(*args, **kwargs):
        # The student's code that made the call, past any of PLL's own - a
        # library function it handed this one to, another contract's wrapper.
        caller = _sys._getframe(1)
        while caller.f_back is not None and not _pll_is_students(caller.f_code.co_filename):
            caller = caller.f_back
        taker = _pll_party_of_code(caller.f_code)
        blame = _PllBlame(
            definition.party, taker, definition.party, (), (caller.f_code.co_filename, caller.f_lineno, None),
            definition.level,
        )
        return _pll_wrapped(function, definition, blame)(*args, **kwargs)

    for attribute in _PLL_WRAPPER_ASSIGNMENTS:
        setattr(contracted, attribute, getattr(function, attribute))
    contracted.__wrapped__ = function
    contracted.__signature__ = definition.signature
    contracted.__pll_obligations__ = {None: contracted}
    _PLL_BOUNDARIES[contracted] = definition
    return contracted


def _pll_contract_def(party, written, quoted):
    """The decorator compile.py puts innermost on each annotated `def`: the
    function, under its contract, at its boundary (`_pll_boundary`). A
    reference compile.py has rewritten makes its own obligation instead."""

    def attach(function):
        level = function.__globals__.get("__pll_level__")
        definition = _PllDefinition(function, _pll_party(party), dict(written), frozenset(quoted), level)
        definition.validate()
        return _pll_boundary(function, definition)

    return attach


# -- annotations, read as contracts -----------------------------------------------


class _PllUnresolved(Exception):
    """A name in quotes that names nothing, or no type, as yet."""

    def __init__(self, reason, name):
        super().__init__(name)
        self.reason = reason
        self.name = name


#: Where a field annotation of a dataclass PLL checks is looked up: the
#: globals its class was defined in, by class.
_PLL_CLASS_NAMESPACES = _pll_weakref.WeakKeyDictionary()

_PLL_ITEMS = {
    list: True, _pll_collections.deque: True,
    set: False, frozenset: False,
    _pll_abc.Sequence: True, _pll_abc.MutableSequence: True,
    _pll_abc.Set: False, _pll_abc.MutableSet: False,
}
_PLL_MAPPINGS = (
    dict, _pll_collections.OrderedDict, _pll_collections.defaultdict, _pll_collections.Counter,
    _pll_abc.Mapping, _pll_abc.MutableMapping,
)


def _pll_compile(annotation, written, namespace, level, typevars=None, forced=False):
    """The contract `annotation` makes. `written` is how the program wrote
    it, or None for its own text; `namespace` is where a name in quotes is
    looked up; `typevars` is what each type parameter stands for, inside a
    generic type with its type filled in.

    `forced` makes a name in quotes now rather than when first checked: a
    `def`'s annotations are made at its first call, which is late enough.
    """
    typevars = typevars or {}
    text = written if written else _pll_type_text(annotation, typevars)
    if isinstance(annotation, str) or isinstance(annotation, _pll_typing.ForwardRef):
        quoted = annotation if isinstance(annotation, str) else annotation.__forward_arg__

        def resolved():
            return _pll_compile(_pll_contract_resolve(quoted, namespace, typevars), text, namespace, level, typevars, forced)

        return resolved() if forced else _PllLaterContract(resolved, text)
    if annotation is None or annotation is type(None):
        return _PllNoneContract("None")
    if annotation is _pll_typing.Any or annotation is object:
        return _PllAnyContract(text)
    if annotation is _pll_typing.NoReturn or annotation is _pll_typing.Never:
        return _PllNeverContract(text)
    if isinstance(annotation, (_pll_typing.TypeVar, _pll_typing.ParamSpec, _pll_typing.TypeVarTuple)):
        # A type parameter stands for any type: Racket would seal the value
        # (`parametric->/c`), and a sealed leaf is one `tree_fold` cannot read.
        return typevars.get(annotation, _PllAnyContract(text))
    if isinstance(annotation, _pll_typing.TypeAliasType):
        return _PllLaterContract(
            lambda: _pll_compile(annotation.__value__, text, namespace, level, typevars), text
        )
    if isinstance(annotation, _pll_typing.NewType):
        return _pll_compile(annotation.__supertype__, text, namespace, level, typevars)
    origin = _pll_typing.get_origin(annotation)
    args = _pll_typing.get_args(annotation)

    def part(arg):
        return _pll_compile(arg, None, namespace, level, typevars)

    if origin is _pll_typing.Union or origin is _pll_types.UnionType:
        return _PllUnionContract([part(arg) for arg in args], text)
    if origin is _pll_typing.Literal:
        return _PllLiteralContract(args, text)
    if origin is _pll_typing.Annotated:
        return _pll_compile(args[0], text, namespace, level, typevars)
    if origin in (_pll_typing.ClassVar, _pll_typing.Final):
        return _pll_compile(args[0], text, namespace, level, typevars) if args else _PllAnyContract(text)
    if isinstance(origin, _pll_typing.TypeAliasType):
        bound = dict(typevars)
        bound.update(zip(origin.__type_params__, [part(arg) for arg in args]))
        return _PllLaterContract(lambda: _pll_compile(origin.__value__, text, namespace, level, bound), text)
    if origin is _pll_abc.Callable:
        return _pll_callable_contract(args, text, part)
    if origin is tuple:
        if not args:
            return _PllClassContract(tuple, text, level)
        if len(args) == 2 and args[1] is Ellipsis:
            return _PllTupleContract([part(args[0])], text, repeated=True)
        if args == ((),):
            return _PllTupleContract([], text, repeated=False)
        return _PllTupleContract([part(arg) for arg in args], text, repeated=False)
    if origin is type:
        target = args[0] if args else None
        return _PllClassOfContract(target if isinstance(target, type) else None, text)
    if origin in _PLL_ITEMS:
        return _PllItemsContract(origin, part(args[0]) if args else _PLL_ANY, text, _PLL_ITEMS[origin])
    if origin in _PLL_MAPPINGS:
        key, value = (part(args[0]), part(args[1])) if len(args) == 2 else (_PLL_ANY, _PLL_ANY)
        if origin is _pll_collections.Counter:
            key, value = (part(args[0]) if args else _PLL_ANY), _PllClassContract(int, "int", level)
        return _PllMappingContract(origin, key, value, text)
    if isinstance(origin, type):
        if args and _pll_dataclasses.is_dataclass(origin) and getattr(origin, "__type_params__", ()):
            return _pll_data_contract(origin, args, text, level, part)
        # A collection that cannot be gone through twice (an iterator), or a
        # class that is generic in some other way: the class alone.
        return _PllClassContract(origin, text, level)
    if isinstance(annotation, type):
        return _PllClassContract(annotation, text, level)
    if _pll_is_typing_form(annotation):
        # A form of `typing`'s with no check of its own here (`Self`,
        # `TypeGuard[...]`): nothing is refused for it.
        return _PllAnyContract(text)
    raise _PllUnresolved(_pll_why_not_a_type(annotation) or "not-a-type", text)


def _pll_callable_contract(args, text, part):
    """`Callable[[A, B], R]`, `Callable[..., R]`, and `Callable` alone."""
    if not args:
        return _PllFunctionContract(None, _PLL_ANY, text)
    takes, result = args[0], args[1]
    if takes is Ellipsis or isinstance(takes, (_pll_typing.ParamSpec,)):
        return _PllFunctionContract(None, part(result), text)
    params = [(None, None, part(arg), _pll_type_text(arg)) for arg in takes]
    return _PllFunctionContract(params, part(result), text)


def _pll_data_contract(cls, args, text, level, part):
    """`Leaf[float]`: the dataclass `Leaf` with its `T` as `float`."""
    bound = dict(zip(cls.__type_params__, [part(arg) for arg in args]))
    namespace = _PLL_CLASS_NAMESPACES.get(cls) or vars(_sys.modules.get(cls.__module__, _sys))

    def fields():
        made = {}
        for field in _pll_dataclasses.fields(cls):
            made[field.name] = _pll_compile(field.type, None, namespace, level, bound)
        return made

    return _PllDataContract(cls, fields, text)


def _pll_contract_resolve(quoted, namespace, typevars):
    """What a name in quotes names, now - with any type parameters in scope."""
    local = {getattr(typevar, "__name__", None): typevar for typevar in typevars}
    try:
        return eval(quoted, namespace, local)
    except NameError as error:
        raise _PllUnresolved("undefined", getattr(error, "name", None) or quoted) from None
    except SyntaxError:
        raise _PllUnresolved("not-a-name", quoted) from None
    except Exception:
        raise _PllUnresolved("not-a-type", quoted) from None


def _pll_is_typing_form(annotation):
    """Whether `annotation` is one of `typing`'s own forms."""
    return type(annotation).__module__ in ("typing", "typing_extensions")


def _pll_why_not_a_type(annotation):
    """Why `annotation` is not a type, or None if it is one - for what an
    annotation evaluated to when its `def` ran. A string here was not
    written in quotes in the annotation (those are names, looked up later):
    it is a variable that holds one."""
    if isinstance(annotation, str):
        return "string"
    if annotation is None or annotation is Ellipsis or isinstance(annotation, (type, _pll_typing.TypeVar)):
        return None
    if isinstance(annotation, (_pll_typing.ForwardRef, _pll_typing.TypeAliasType, _pll_typing.NewType)):
        return None
    origin = _pll_typing.get_origin(annotation)
    if origin is not None:
        if origin is _pll_typing.Literal:
            return None
        for arg in _pll_typing.get_args(annotation):
            if isinstance(arg, list):
                reason = next((r for r in map(_pll_why_not_a_type, arg) if r is not None and r != "string"), None)
            elif isinstance(arg, str):
                # In brackets, a string is a name in quotes, as typing reads it.
                reason = None
            else:
                reason = _pll_why_not_a_type(arg)
            if reason is not None:
                return reason
        return None
    if _pll_is_typing_form(annotation):
        return None
    if isinstance(annotation, bool):
        return "value"
    if isinstance(annotation, (int, float, complex)):
        return "number"
    if callable(annotation):
        return "function"
    if isinstance(annotation, _pll_types.ModuleType):
        return "module"
    return "value"


def _pll_type_text(annotation, typevars=None):
    """A type as a program would write it: `list[int]`, `int | None` - with
    a type parameter as what it stands for, where `typevars` says."""
    if typevars and isinstance(annotation, _pll_typing.TypeVar) and annotation in typevars:
        return typevars[annotation].written
    if annotation is None or annotation is type(None):
        return "None"
    if annotation is Ellipsis:
        return "..."
    if isinstance(annotation, str):
        return annotation
    if isinstance(annotation, _pll_typing.ForwardRef):
        return annotation.__forward_arg__
    if isinstance(annotation, list):
        return "[%s]" % ", ".join(_pll_type_text(arg, typevars) for arg in annotation)
    origin = _pll_typing.get_origin(annotation)
    args = _pll_typing.get_args(annotation)
    if origin is _pll_typing.Union or origin is _pll_types.UnionType:
        return " | ".join(_pll_type_text(arg, typevars) for arg in args)
    if origin is _pll_typing.Literal:
        return "Literal[%s]" % ", ".join(repr(arg) for arg in args)
    if origin is not None:
        name = _pll_type_text(origin)
        return "%s[%s]" % (name, ", ".join(_pll_type_text(arg, typevars) for arg in args)) if args else name
    if isinstance(annotation, type):
        name = _pll_course_type_name(annotation.__qualname__)
        module = annotation.__module__
        if module == "collections.abc":
            return annotation.__qualname__
        return name
    name = getattr(annotation, "__name__", None)
    if isinstance(name, str):
        return name
    return repr(annotation).replace("typing.", "")


# -- assignments and fields --------------------------------------------------------


#: Contracts made from an annotation that is itself the type (`int`,
#: `list[int]`), by `(annotation, level)`: an assignment makes its contract
#: each time it runs.
_PLL_MADE = {}


def _pll_contract_of(annotation, written, namespace, level):
    try:
        key = (annotation, level)
        made = _PLL_MADE.get(key)
    except TypeError:
        key = made = None
    if made is None:
        made = _pll_compile(annotation, written, namespace, level)
        if key is not None and not isinstance(annotation, str):
            _PLL_MADE[key] = made
    return made


def _pll_contract_assigned(value, annotation, written, name, party, line, quoted):
    """The value an annotated variable is given, checked against its
    annotation. The code that gives it is the party that answers for it - it
    gives the value, and takes it again by using the variable."""
    frame = _sys._getframe(1)
    namespace = frame.f_globals
    level = namespace.get("__pll_level__")
    taker = _pll_party(party)
    step = ("variable", name, written)
    blame = _PllBlame(taker, taker, None, (step,), (taker.file, line, None), level)
    if isinstance(annotation, str) and not quoted:
        _pll_not_a_type("string", written, None, step, value=annotation)
    reason = None if quoted else _pll_why_not_a_type(annotation)
    if reason is not None:
        _pll_not_a_type(reason, written, None, step, value=annotation)
    try:
        contract = _pll_contract_of(annotation, written, namespace, level)
        return contract.check(value, blame)
    except _PllUnresolved as unresolved:
        _pll_not_a_type(unresolved.reason, written, None, step, missing=unresolved.name)


# -- a broken contract -------------------------------------------------------------


def _pll_broken(contract, value, blame):
    """Raise the violation: `value` failed `contract`, and `blame.positive`
    answers for it."""
    check = _pll_violation(contract, value, blame)
    error = _PllTypeMismatch(_pll_violation_message(check))
    _pll_add_facts(
        error,
        check=check,
        element_value=_pll_describe(value) if check["element"] is not None else None,
        element_type=_pll_type_name(value) if check["element"] is not None else None,
    )
    raise error


def _pll_violation(contract, value, blame):
    """What the explanation is told about a broken contract.

    - `kind` is what the annotation is on - "argument", "return",
      "variable", "field" - `name` its name, and `annotation` how it was
      written; `function` is the definition whose contract it is.
    - `element` is the part of a collection that failed ("item 2"), when
      that is all that lies between the annotation and the failure; when a
      function's argument or result lies between, the contract was broken
      higher-order (`higher_order`), and `path` gives the way down.
    - `actual` and `value` are what the value was, and `expected` the types
      that would have been accepted where it failed.
    - `blamed` is the party that broke it: the definition (`role` "owner")
      or the one that used it (`role` "client"); `site` is where that use
      made the obligation, and `returned_at` the line of the `return`
      whose value broke it.
    """
    path = blame.path
    top = path[0] if path else ("variable", None, "")
    kind = {"argument": "argument", "result": "return", "variable": "variable", "field": "field"}.get(
        top[0], "unknown"
    )
    calls = [index for index, step in enumerate(path) if step[0] in ("argument", "result")]
    inside = path[calls[-1] + 1 :] if calls else path[1:]
    # For a part of a collection, the collection is what was given: "item 0
    # of the list you passed".
    actual = inside[0][-1] if inside else (
        "class %s" % value.__qualname__ if isinstance(value, type) else _pll_type_name(value)
    )
    owner = blame.owner
    site = blame.site
    return {
        "kind": kind,
        "name": top[1] if top[0] in ("argument", "variable", "field") else None,
        "annotation": top[-1] if top[-1] else None,
        "function": owner.name if owner is not None and owner.kind == "function" else None,
        "owner": top[2] if top[0] == "field" else None,
        "element": _pll_element_words(inside) if inside else None,
        "higher_order": len(calls) > 1,
        "path": [_pll_step_fact(step) for step in path],
        # A class where one made from it was meant is said as such.
        "actual": actual,
        "value": _pll_shown_value(value),
        "expected": contract.expected(),
        "blamed": blame.positive.fact(),
        "role": "owner" if owner is not None and blame.positive is owner else "client",
        "site": {"file": _pll_shown_file(site[0]), "line": site[1], "column": site[2]} if site else None,
        "returned_at": top[1] if top[0] == "result" else None,
        "applied": _pll_applied(blame.positive),
        "level": blame.level,
        "arity": _pll_arity(contract, value),
    }


def _pll_arity(contract, value):
    """For a function that failed a function contract's first-order check
    because of how many arguments it takes: how many the contract calls it
    with, and the parameters it has."""
    if not isinstance(contract, _PllFunctionContract) or contract.params is None or not callable(value):
        return None
    try:
        parameters = list(_pll_inspect.signature(value).parameters)
    except (TypeError, ValueError):
        return None
    return {"wanted": len(contract.params), "parameters": parameters}


def _pll_applied(party):
    """Where the student's code was when the contract broke - the call that
    gave the value, or the one the value came back to - and whether that
    code is the blamed party's own."""
    frame = _sys._getframe(1)
    while frame is not None and not _pll_is_students(frame.f_code.co_filename):
        frame = frame.f_back
    if frame is None:
        return None
    return {
        "file": _pll_shown_file(frame.f_code.co_filename),
        "line": frame.f_lineno,
        "function": _pll_party_of_code(frame.f_code).name,
        "by_blamed": party.owns(frame.f_code),
    }


def _pll_step_fact(step):
    """A step of a path, as data."""
    kind = step[0]
    if kind == "argument":
        return {"kind": "argument", "name": step[1], "index": step[2], "annotation": step[3]}
    if kind == "result":
        return {"kind": "result", "line": step[1], "annotation": step[2]}
    if kind in ("variable", "field"):
        return {"kind": kind, "name": step[1], "annotation": step[-1]}
    if kind == "item":
        return {"kind": "item", "index": step[1], "in": step[2]}
    if kind in ("key", "value"):
        return {"kind": kind, "key": _pll_shown_value(step[1]), "in": step[2]}
    if kind == "part":
        return {"kind": "field", "name": step[1], "in": step[2]}
    return {"kind": kind, "in": step[-1]}


def _pll_element_words(steps):
    """The part of a collection that failed - "item 2", "value of key 'a'",
    the words explain/typeCheck.py reads - inmost first: "item 1 of
    item 0"."""
    words = []
    for step in steps:
        if step[0] == "item":
            words.append("item %d" % step[1])
        elif step[0] == "member":
            words.append("one of the items")
        elif step[0] == "key":
            words.append("key %r" % (step[1],))
        elif step[0] == "value":
            words.append("value of key %r" % (step[1],))
        elif step[0] == "part":
            words.append("the %s of a %s" % (step[1], step[2]))
    return " of ".join(reversed(words))


def _pll_type_name(value):
    """The type of `value`, as the course names it."""
    return _pll_course_type_name(type(value).__name__)


def _pll_shown_value(value):
    """A value as a message quotes it: a string in double quotes."""
    if isinstance(value, str) and '"' not in value:
        return '"%s"' % value
    try:
        shown = repr(value)
    except Exception:
        shown = "?"
    return shown if len(shown) <= 60 else shown[:57] + "..."


def _pll_violation_message(check):
    """The violation in a sentence, for anywhere nothing explains it."""
    what = {
        "argument": "argument %s" % check["name"],
        "return": "the return value",
        "variable": "the value assigned to %s" % check["name"],
        "field": "field %s" % check["name"],
    }.get(check["kind"], "a value")
    if check["function"] and check["kind"] in ("argument", "return"):
        what += " of %s" % check["function"]
    if check["element"]:
        what = "%s of %s" % (check["element"], what)
    return "%s is %s (%s), not %s" % (what, check["value"], check["actual"], " or ".join(check["expected"]))


def _pll_not_a_type(reason, written, party, step, value=None, missing=None, members=None):
    """Raise the error for an annotation that is not a type."""
    facts = {
        "reason": reason,
        "annotation": written,
        "function": party.name if party is not None and party.kind == "function" else None,
        "kind": "return" if step[0] == "result" else step[0],
        "name": step[1] if step[0] != "result" else None,
        "value": None if value is None else _pll_shown_value(value),
        "value_type": None if value is None else _pll_course_type_name(type(value).__name__),
        "missing": missing,
        "members": members,
        "file": _pll_shown_file(party.file) if party is not None else None,
        "line": party.line if party is not None else None,
    }
    error = _PllNotAType("%s is not a type" % written)
    _pll_add_facts(error, not_a_type=facts)
    raise error


# -- names PLL's instrumentation calls ---------------------------------------------


_PLL_REF = _pll_hidden("ref", _pll_ref)
_PLL_CONTRACT_DEF = _pll_hidden("contract_def", _pll_contract_def)
_PLL_RETURNING = _pll_hidden("returning", _pll_returning)
_PLL_ASSIGNED = _pll_hidden("assigned", _pll_contract_assigned)
