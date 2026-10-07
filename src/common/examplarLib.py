# Python Language Levels: Examplar support.
#
# Examplar (Wrenn, Politz et al.) assesses a *test suite* rather than an
# implementation. Students write tests first; those tests are run against
# known-good implementations ("wheats"), where they must all pass, and
# known-bad ones ("chaffs"), where each must be caught by at least one
# failing test. A failure on a wheat means the student's expectation is
# wrong; a chaff nobody catches means their suite has a gap.
#
# Two primitives live here, both used by the command line and the editor:
#
#   _pll_examplar_build(sources_json) -> bundle dict      (authoring)
#   _pll_examplar_run(test_src, bundle_json) -> results   (both hosts)
#
# Implementations travel as `.pyc` bytecode, compiled *by this interpreter*.
# That is deliberate: bytecode is tied to the Python minor version, and
# compiling inside Pyodide makes the magic number match by construction
# rather than by asking course staff to keep a matching CPython around.
#
# Bytecode hides the source from `inspect.getsource`, and nothing more -
# `dis` and `co_consts` still tell the whole story to anyone who looks.
# That is accepted, not overlooked: the autograder holds the grade, so this
# check needs to be fast and honest rather than secret.

import ast as _ex_ast
import base64 as _ex_b64
import contextlib as _ex_contextlib
import importlib.util as _ex_util
import io as _ex_io
import marshal as _ex_marshal
import sys as _ex_sys
import time as _ex_time
import types as _ex_types

EXAMPLAR_FORMAT = 2

#: How long one test may run against one implementation - or one of the
#: student's definitions, or an implementation, take to load. Anything that
#: runs longer is stuck, and the check stops there (`_PllExamplarTimeout`).
_PLL_EXAMPLAR_SECONDS = 2.0

#: How many trace events pass between looks at the clock.
_PLL_EXAMPLAR_CLOCK_EVERY = 1024


class _PllExamplarTimeout(BaseException):
    """Raised into code that ran past `_PLL_EXAMPLAR_SECONDS`. A
    `BaseException`, so a test's own `except Exception` does not swallow it."""


@_ex_contextlib.contextmanager
def _pll_examplar_budget():
    """Run the body with `_PLL_EXAMPLAR_SECONDS` to finish in.

    A trace function rather than the interrupt channel Stop uses, so it
    works wherever the check runs, with or without one. A loop in Python
    code is caught; one inside a single call into C is not.
    """
    deadline = _ex_time.monotonic() + _PLL_EXAMPLAR_SECONDS
    events = [0]

    def tracer(frame, event, arg):
        events[0] += 1
        if events[0] % _PLL_EXAMPLAR_CLOCK_EVERY == 0 and _ex_time.monotonic() > deadline:
            raise _PllExamplarTimeout()
        return tracer

    previous = _ex_sys.gettrace()
    _ex_sys.settrace(tracer)
    try:
        yield
    finally:
        _ex_sys.settrace(previous)


def _pll_examplar_magic():
    """Hex of this interpreter's bytecode magic, for bundle metadata."""
    return _ex_util.MAGIC_NUMBER.hex()


def _pll_examplar_top_level_names(source, filename):
    """Public top-level names a source file defines.

    From the AST, so nothing is executed at authoring time - a wheat is
    still ordinary code someone wrote, and building a bundle should not run
    it.
    """
    names = set()
    for node in _ex_ast.parse(source, filename=filename).body:
        if isinstance(node, (_ex_ast.FunctionDef, _ex_ast.AsyncFunctionDef, _ex_ast.ClassDef)):
            if not node.name.startswith("_"):
                names.add(node.name)
        elif isinstance(node, _ex_ast.Assign):
            for target in node.targets:
                if isinstance(target, _ex_ast.Name) and not target.id.startswith("_"):
                    names.add(target.id)
    return names


def _pll_examplar_compile(source, filename):
    """Source -> base64 of a `.pyc` payload (marshalled code, no header).

    The import-machinery header is left off on purpose: these are loaded by
    `marshal.loads` rather than by an import hook, so the magic number is
    carried once in the bundle's metadata instead of on every blob.
    """
    code = compile(source, filename, "exec")
    return _ex_b64.b64encode(_ex_marshal.dumps(code)).decode("ascii")


def _pll_examplar_build(sources_json):
    """Compile wheats and chaffs into a bundle.

    `sources_json` is `{"wheats": {id: source},
                        "chaffs": {function: {id: source}}}`.
    Returns a dict with `ok`, and either `bundle` or `error`.

    Chaffs are grouped by the function they break, because the student's
    report is per function: *these* tests of `initials` caught *these*
    implementations of `initials`. Nothing can infer that grouping reliably
    - a chaff is a whole file, and the functions it leaves alone still differ
    from the wheat's by whitespace - so the author states it, by which
    directory the chaff lives in.

    Every implementation must define the same public names: a suite is run
    against all of them interchangeably, so one that is missing a function
    would fail for a reason that has nothing to do with the student.
    """
    import json as _ex_json

    try:
        sources = _ex_json.loads(sources_json)
    except ValueError as e:
        return {"ok": False, "error": "could not read the sources (%s)" % e}

    provides = None

    def compile_one(filename, source):
        """-> (blob, error). Also checks the file defines the same names."""
        nonlocal provides
        try:
            names = _pll_examplar_top_level_names(source, filename)
            blob = _pll_examplar_compile(source, filename)
        except SyntaxError as e:
            return None, "%s does not parse: %s (line %s)" % (filename, e.msg, e.lineno)
        if provides is None:
            provides = names
        elif names != provides:
            detail = []
            if provides - names:
                detail.append("missing " + ", ".join(sorted(provides - names)))
            if names - provides:
                detail.append("unexpected " + ", ".join(sorted(names - provides)))
            return None, (
                "%s defines a different set of names than the others (%s). "
                "Every wheat and chaff has to define the same functions."
                % (filename, "; ".join(detail))
            )
        return blob, None

    wheats = []
    for ident, source in sorted((sources.get("wheats") or {}).items()):
        blob, error = compile_one("wheats/%s.py" % ident, source)
        if error:
            return {"ok": False, "error": error}
        wheats.append({"id": ident, "pyc": blob})

    chaffs = []
    for function, group in sorted((sources.get("chaffs") or {}).items()):
        for ident, source in sorted((group or {}).items()):
            blob, error = compile_one("chaffs/%s/%s.py" % (function, ident), source)
            if error:
                return {"ok": False, "error": error}
            chaffs.append({"id": ident, "targets": function, "pyc": blob})

    if not wheats:
        return {"ok": False, "error": "a bundle needs at least one wheat"}
    if not chaffs:
        return {"ok": False, "error": "a bundle needs at least one chaff"}

    # A chaff directory that is not one of the functions would silently never
    # be reported - no card would ever mention it.
    targeted = {entry["targets"] for entry in chaffs}
    provides = provides or set()
    stray = sorted(targeted - provides)
    if stray:
        return {
            "ok": False,
            "error": (
                "chaffs/%s is not one of the functions in this bundle (%s). "
                "A chaff goes in a directory named after the function it breaks."
                % (stray[0], ", ".join(sorted(provides)) or "none")
            ),
        }
    # And a function with no chaffs gets a card that can never say anything
    # about how thorough its tests are, which is half of what a card is for.
    barren = sorted(provides - targeted)
    if barren:
        return {
            "ok": False,
            "error": (
                "%s has no chaffs, so nothing would ever measure how thorough a "
                "student's tests of it are. Add chaffs/%s/1.py."
                % (barren[0], barren[0])
            ),
        }

    import sys as _ex_sys

    return {
        "ok": True,
        "bundle": {
            "examplar": EXAMPLAR_FORMAT,
            "built": {
                "python": _ex_sys.version.split()[0],
                "magic": _pll_examplar_magic(),
            },
            "provides": sorted(provides),
            "wheats": wheats,
            "chaffs": chaffs,
        },
    }


def _pll_examplar_free_names(fn_node):
    """Names a function body reads without binding them itself."""
    arguments = fn_node.args
    bound = {arg.arg for arg in arguments.posonlyargs + arguments.args + arguments.kwonlyargs}
    bound.update(arg.arg for arg in (arguments.vararg, arguments.kwarg) if arg is not None)
    read = set()
    for node in _ex_ast.walk(fn_node):
        if isinstance(node, _ex_ast.Name):
            if isinstance(node.ctx, _ex_ast.Store):
                bound.add(node.id)
            else:
                read.add(node.id)
    return read - bound


def _pll_examplar_attribution(test_source, provides):
    """Which provided names each `test_*` function exercises.

    This decides which card a test appears on, so it has to follow the
    student's own helpers. A test written as

        def check(name, expected):
            assert initials(name) == expected

        def test_ada():
            check("Ada Lovelace", "A.L.")

    reads `check`, not `initials`, and a direct free-variable scan would
    file it under nothing at all and quietly leave it off every card. So the
    reachable set is closed over the file's own top-level functions.

    It stops at a provided name rather than descending into it: during the
    phase that name is the *bundle's* function, so whatever the student's
    version of it happens to call is beside the point.

    Not needed for the verdicts themselves, so a parse failure is not fatal.
    """
    out = {}
    try:
        tree = _ex_ast.parse(test_source)
    except SyntaxError:
        return out
    wanted = set(provides)
    reads = {}
    for node in tree.body:
        if isinstance(node, (_ex_ast.FunctionDef, _ex_ast.AsyncFunctionDef)):
            reads[node.name] = _pll_examplar_free_names(node)
    for name in reads:
        if not name.startswith("test_"):
            continue
        reached = set()
        seen = set()
        pending = [name]
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            for read in reads.get(current, ()):
                reached.add(read)
                if read in reads and read not in wanted:
                    pending.append(read)
        out[name] = sorted(reached & wanted)
    return out


def _pll_examplar_raised_in_implementation(exc, student_file):
    """Whether `exc` came from the implementation rather than the student's
    own code: the innermost frame of either's, from the inside out. A
    library the implementation called counts as the implementation."""
    frames = []
    tb = exc.__traceback__
    while tb is not None:
        frames.append(tb.tb_frame.f_code.co_filename)
        tb = tb.tb_next
    for filename in reversed(frames):
        if filename == student_file:
            return False
        if filename.startswith(("wheats/", "chaffs/")):
            return True
    return False


def _pll_examplar_outcome(exc, student_file):
    """How a test ended, and what to say about it.

    A test the implementation itself refused - `shout("")` raising its own
    `ValueError` - disagrees with it, as a wrong expectation does. Its
    message is the implementation's, so it is kept for `--verify` and never
    shown to a student. Only an error from the student's own code is one
    their test "could not run" past.
    """
    if exc is None:
        return {"outcome": "pass", "message": None}
    if isinstance(exc, AssertionError):
        # Kept for `--verify`, whose reader is the author. A student is shown
        # the test's name and not this - see `_pll_examplar_compile_tests`.
        return {"outcome": "fail", "message": str(exc) or "assertion failed"}
    message = "%s: %s" % (type(exc).__name__, exc)
    if _pll_examplar_raised_in_implementation(exc, student_file):
        return {"outcome": "fail", "message": message}
    return {"outcome": "error", "message": message}


# The top-level statements that give a file its *names*. Everything else is
# the student's program, and the phase deliberately does not run that: it
# runs properly a moment later, once, with the workspace mounted. Running it
# here as well would mean one copy of every side effect per implementation -
# four `print`s, four reactors - and a top-level `input()` would block the
# check forever, because nothing is listening for stdin during it.
_PLL_EXAMPLAR_DEFINITIONS = (
    _ex_ast.Import,
    _ex_ast.ImportFrom,
    _ex_ast.FunctionDef,
    _ex_ast.AsyncFunctionDef,
    _ex_ast.ClassDef,
    _ex_ast.Assign,
    _ex_ast.AnnAssign,
    _ex_ast.AugAssign,
)


def _pll_examplar_compile_tests(test_source, filename):
    """-> [(line, code)], one for each definition: see below."""
    return [
        (node.lineno, code)
        for node, code in _pll_examplar_compiled_definitions(test_source, filename)
    ]


def _pll_examplar_compiled_definitions(test_source, filename):
    """Compile the student's definitions, one statement at a time.

    Through pytest's assertion rewriting, so a failure carries the values it
    saw: `assert 'HI!' == 'hi!'` rather than "assertion failed".

    That message is for the **author**, through `--verify`, where a wheat
    failure means one of their own tests is wrong and there is nothing to
    give away. It never reaches a student: the card names the test and stops
    there, because the rewritten form states the correct answer, and a card
    that hands that over is an oracle rather than a check. The host drops it
    when building the card; it is computed here because the same primitive
    serves both readers.

    One code object per statement rather than one for the module, so a
    definition that cannot be loaded here costs only itself instead of the
    whole verdict. `DATA = open("data.csv").read()` is the case that matters:
    the phase runs with the workspace unmounted, so that line cannot work,
    and losing all of a student's feedback over it would be a poor trade.

    Compiled once and reused for every implementation, so N chaffs still
    cost one compile. Falls back to a plain parse when pytest is not loaded,
    so the verdicts still work - just with poorer messages.
    """
    tree = _ex_ast.parse(test_source, filename=filename)
    try:
        from _pytest.assertion.rewrite import rewrite_asserts

        rewrite_asserts(tree, test_source.encode("utf-8"), module_path=filename)
        # Not `fix_missing_locations`, which copies parent positions onto
        # pytest's injected nodes and produces ranges Python 3.12+ rejects.
        _pll_fix_ast_ranges(tree)
    except Exception:
        # Rewriting can leave the tree half-modified, so start again from the
        # source rather than compiling whatever it got to.
        tree = _ex_ast.parse(test_source, filename=filename)
    pieces = []
    # Recorded and dropped, like the test phase's: the run that follows
    # compiles the same file and says each warning once.
    try:
        with _pll_recording_compile_warnings():
            for node in tree.body:
                if isinstance(node, _PLL_EXAMPLAR_DEFINITIONS):
                    pieces.append((
                        node,
                        compile(_ex_ast.Module(body=[node], type_ignores=[]), filename, "exec"),
                    ))
    finally:
        del _pll_compile_warnings[:]
    return pieces


def _pll_examplar_run_one(test_pieces, code_blob, student_file, provided=(), only=None):
    """Run every `test_*` the student defined against one implementation.

    Their definitions are loaded first and the implementation second, so a
    name the implementation provides replaces whatever the student wrote.
    That is the Examplar semantics: their tests are judged against this
    code, not against their own attempt.

    A definition that raises is skipped rather than fatal, for the reason
    `_pll_examplar_compile_tests` splits them up. Any test that needed it
    then raises its own `NameError`, which the host reports as a test that
    could not run - not as a test that expects the wrong answer.

    `only` restricts which tests are run, and chaffs use it: a chaff of
    `shout` must be judged by the tests of `shout` and nothing else. A test
    of `total` fails on it too - a broken `total` test fails on everything -
    and counting that as having caught it would credit the student for a
    signal that has nothing to do with the function.

    Run in a module made `__main__`, starting with the names a run starts
    with - the libraries' among them - so an image assignment's tests can
    call `image_width` and its implementations `circle`. Whatever runs past
    `_PLL_EXAMPLAR_SECONDS` ends it: `timed_out` names the test, or None for
    a definition or the implementation's own loading.
    """
    module = _ex_types.ModuleType("__main__")
    module.__dict__.update(_pll_initial_globals)
    namespace = module.__dict__
    # The student's definitions that could not be loaded here, and why.
    unloaded = []
    results = {}

    def ended(timed_out, **extra):
        return {
            "loaded": True,
            "tests": results,
            "student_defines": student_defines,
            "unloaded": unloaded,
            "timed_out": timed_out,
            **extra,
        }

    student_defines = []
    with _pll_as_main(module):
        for line, piece in test_pieces:
            try:
                with _pll_examplar_budget():
                    exec(piece, namespace)
            except _PllExamplarTimeout:
                return ended(None)
            except Exception as e:
                # Deliberately `Exception`, not `BaseException`: a
                # `KeyboardInterrupt` from the Stop button has to get out.
                unloaded.append({"line": line, "error": "%s: %s" % (type(e).__name__, e)})
        # Which provided names the student has written themselves, recorded
        # *before* the overlay replaces them. The host uses this to decide
        # whether running their tests against their own code makes sense yet:
        # early in the exercise there is no implementation, and doing so would
        # just spray NameErrors.
        student_defines = sorted(name for name in provided if name in namespace)
        try:
            with _pll_examplar_budget():
                exec(_ex_marshal.loads(_ex_b64.b64decode(code_blob)), namespace)
        except KeyboardInterrupt:
            # A Stop, not a broken implementation, which the card would report
            # as "the bundle may need rebuilding".
            raise
        except _PllExamplarTimeout:
            return ended(None)
        except BaseException as e:
            return {
                **ended(None),
                "loaded": False,
                "error_type": type(e).__name__,
                "error_message": "the implementation could not be loaded (%s)" % e,
                "traceback": "",
                "tests": {},
                "timed_out": False,
            }

        for name in sorted(namespace):
            if not name.startswith("test_"):
                continue
            if only is not None and name not in only:
                continue
            fn = namespace[name]
            if not callable(fn):
                continue
            try:
                with _pll_examplar_budget():
                    fn()
                results[name] = _pll_examplar_outcome(None, student_file)
            except KeyboardInterrupt:
                # A Stop ends the whole check. Recorded as this test's error, it
                # let the next implementation run the same test - which, if it
                # loops, needed another Stop, and another, one per implementation.
                raise
            except _PllExamplarTimeout:
                return ended(name)
            except BaseException as e:
                results[name] = _pll_examplar_outcome(e, student_file)
    return ended(False)


def _pll_examplar_run(test_source, bundle_json, filename="hw.py"):
    """Run a student's suite against a bundle, per function and in two phases.

    Returns a dict the host turns into one report per provided function.
    Verdicts, for each function separately:
      * a test failing on any wheat  -> that test is wrong
      * a chaff with no failing test -> the suite has a gap there

    The second phase only happens where the first one *passed*, and it is
    decided per function: `initials` having a wrong test says nothing about
    how well `longest` is tested, so it must not hold that report back. A
    test that disagrees with a correct implementation is wrong, and a wrong
    test fails on *everything* - so it would "catch" every chaff of its
    function, and the number would be an artifact of the bug rather than a
    measure of the suite. A test that *raised* is no better: it raises the
    same way on every implementation. Gating means those chaffs are not even
    run, so nothing about them can be reported before it would mean
    something.

    Two things end the whole check rather than one card: an implementation
    that will not load - the bundle is broken - and anything that runs past
    `_PLL_EXAMPLAR_SECONDS` (`timed_out`), which no later result could be
    trusted after. What the code prints is dropped: the file's own tests,
    which run next, show it once.
    """
    with _ex_contextlib.redirect_stdout(_ex_io.StringIO()), _ex_contextlib.redirect_stderr(_ex_io.StringIO()):
        return _pll_examplar_judge(test_source, bundle_json, filename)


def _pll_examplar_judge(test_source, bundle_json, filename):
    import json as _ex_json

    try:
        bundle = _ex_json.loads(bundle_json)
    except ValueError as e:
        return {"ok": False, "error": "the bundle is not valid JSON (%s)" % e}

    if bundle.get("examplar") != EXAMPLAR_FORMAT:
        return {
            "ok": False,
            "error": "this bundle is format %r, but this PLL understands %d"
            % (bundle.get("examplar"), EXAMPLAR_FORMAT),
        }
    built = bundle.get("built") or {}
    if built.get("magic") and built["magic"] != _pll_examplar_magic():
        return {
            "ok": False,
            "error": (
                "this bundle was built for Python %s and cannot run here "
                "(Python %s). It needs rebuilding with a matching pll-python."
                % (built.get("python", "?"), __import__("sys").version.split()[0])
            ),
        }

    provides = list(bundle.get("provides") or ())
    # The student's own file not compiling is their problem to fix, and the
    # normal run reports it properly - say so once rather than once per
    # implementation. Some code parses and does not compile (`case Boa:`),
    # so this covers both and says neither.
    try:
        test_pieces = _pll_examplar_compile_tests(test_source, filename)
    except SyntaxError as e:
        return {
            "ok": False,
            "error": "your file has a syntax error: %s (line %s)" % (e.msg, e.lineno),
        }

    attribution = _pll_examplar_attribution(test_source, provides)
    result = {
        "ok": True,
        "provides": provides,
        "attribution": attribution,
        "wheats": [],
        "chaffs": [],
        "chaffs_skipped": [],
        "timed_out": None,
    }

    def stopped_by(ran, kind):
        """Record a timeout as the end of the check; True if there was one."""
        if ran["timed_out"] is False:
            return False
        result["timed_out"] = {
            "kind": kind,
            "id": ran["id"],
            "targets": ran.get("targets"),
            "test": ran["timed_out"],
            "seconds": _PLL_EXAMPLAR_SECONDS,
        }
        result["chaffs_skipped"] = sorted(provides)
        return True

    for entry in bundle.get("wheats") or []:
        ran = _pll_examplar_run_one(test_pieces, entry.get("pyc", ""), filename, provides)
        ran["id"] = entry.get("id", "?")
        result["wheats"].append(ran)
        if stopped_by(ran, "wheat"):
            return result

    # A wheat that will not load is a broken bundle, not a student's problem,
    # and there is nothing to measure against - so no phase two anywhere.
    if any(not wheat["loaded"] for wheat in result["wheats"]):
        result["chaffs_skipped"] = sorted(provides)
        return result

    # Phase one, per function: every test that exercises it has to have
    # *passed* on every wheat. Nothing weaker counts - a test that raised did
    # not pass either.
    settled = set()
    for function in provides:
        tests = [name for name, names in attribution.items() if function in names]
        if not tests:
            # No tests for it, so nothing to gate and nothing to measure. The
            # host says "no tests yet" rather than "caught 0 of 3", which
            # would read as a failure at something they have not started.
            continue
        if all(
            wheat["tests"].get(name, {}).get("outcome") == "pass"
            for wheat in result["wheats"]
            for name in tests
        ):
            settled.add(function)

    for entry in bundle.get("chaffs") or []:
        function = entry.get("targets")
        if function not in settled:
            continue
        # Judged by the tests of *its* function only. A test of another one
        # fails on it as well, and crediting that would score the student
        # for a signal that says nothing about this chaff.
        mine = {name for name, names in attribution.items() if function in names}
        ran = _pll_examplar_run_one(test_pieces, entry.get("pyc", ""), filename, provides, mine)
        ran["id"] = entry.get("id", "?")
        ran["targets"] = function
        result["chaffs"].append(ran)
        if stopped_by(ran, "chaff"):
            return result
    result["chaffs_skipped"] = sorted(set(provides) - settled)
    return result
