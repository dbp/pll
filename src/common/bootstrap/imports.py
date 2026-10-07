# The student's own files, imported as they run: each held to its own
# `#level`, whichever file imports it. A grader importing a student's file
# gets that file's checks, and a `#level beginner` helper is still beginner
# when `main.py` imports it.
#
# On import, a file of theirs is checked as a run would check it - a broken
# `#level` line, then the static checks of its level - and refused with
# `ChecksFailed` if it does not pass. Then it is compiled with its level's
# annotation checks, and starts with the names a run starts with (the
# libraries' among them).

import importlib.machinery as _pll_machinery
import importlib.util as _pll_import_util
import json as _pll_json
import os as _pll_os
import sys as _pll_import_sys

#: Each mounted `.py` file's level, as the host read it from its `#level`
#: line (`level.ts`): name -> (level, header problem `{line, message}` or
#: None). A file not in it - one a program wrote and then imported - has no
#: level the host read, and imports as `raw`.
_pll_file_levels = {}

#: A module's own identity, which a copy of `_pll_initial_globals` must not
#: replace.
_PLL_MODULE_OWN = ("__name__", "__file__", "__loader__", "__spec__", "__package__", "__cached__", "__doc__")


def _pll_note_file_levels(levels_json):
    """Record the levels of the files just mounted."""
    _pll_file_levels.clear()
    for name, (level, problem) in _pll_json.loads(levels_json).items():
        _pll_file_levels[name] = (level, problem)


class ChecksFailed(ImportError):
    """One of the student's files did not pass its own level's checks, so
    it was not imported."""


def _pll_level_of_file(path):
    return _pll_file_levels.get(_pll_os.path.basename(path), (_PLL_LEVEL_RAW, None))


class _PllStudentLoader(_pll_machinery.SourceFileLoader):
    """Loads one of the student's files at its own level.

    Always from its source: a cached `.pyc` would be the file compiled for
    whatever level it had then, with or without its checks.
    """

    def get_code(self, fullname):
        path = self.get_filename(fullname)
        source = _pll_import_util.decode_source(self.get_data(path))
        level, problem = _pll_level_of_file(path)
        name = _pll_os.path.basename(path)
        blocking = []
        if problem is None:
            blocking = [f for f in _pll_static_analyze(source, level, path) if f["severity"] == "error"]
        if problem is not None or blocking:
            error = ChecksFailed(
                "%s did not pass the checks of #level %s" % (name, level), name=fullname, path=path
            )
            _pll_add_facts(error, checks={
                "file": name,
                "level": level,
                "findings": blocking,
                "header_problem": problem,
            })
            raise error
        tree = _pll_parse_and_instrument(source, path, level)
        return compile(tree, path, "exec", dont_inherit=True)

    def exec_module(self, module):
        own = module.__dict__
        for key, value in _pll_initial_globals.items():
            if key not in _PLL_MODULE_OWN:
                own.setdefault(key, value)
        own["__pll_level__"] = _pll_level_of_file(self.get_filename(module.__name__))[0]
        super().exec_module(module)


class _PllStudentFinder:
    """Finds the student's files for `_PllStudentLoader`, by the search
    Python itself makes: a file next to the program is theirs only when
    nothing earlier on `sys.path` has its name (`_pll_protect_import_path`).
    """

    @classmethod
    def find_spec(cls, fullname, path=None, target=None):
        spec = _pll_machinery.PathFinder.find_spec(fullname, path, target)
        origin = getattr(spec, "origin", None)
        if (
            isinstance(origin, str)
            and origin.endswith(".py")
            and _pll_os.path.dirname(origin) == _PLL_WORK_DIR
        ):
            spec.loader = _PllStudentLoader(fullname, origin)
        return spec

    @classmethod
    def invalidate_caches(cls):
        pass


def _pll_install_student_finder():
    """Put the finder just before Python's own path search, so built-in and
    frozen modules are found as they always are."""
    meta_path = _pll_import_sys.meta_path
    if _PllStudentFinder in meta_path:
        return
    at = next((i for i, f in enumerate(meta_path) if f is _pll_machinery.PathFinder), len(meta_path))
    meta_path.insert(at, _PllStudentFinder)


_pll_install_student_finder()
