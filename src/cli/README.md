# pll-python

Run Python with [PLL](https://github.com/dbp/pll)'s language levels from the
command line. Same checks, same error messages, same built-in libraries as
the **Python Language Levels** VS Code extension — no Python installation
needed, because it runs on [Pyodide](https://pyodide.org).

Needs **Node 22 or newer** (the oldest Node still receiving support).

```bash
npx pll-python hw.py
```

Or install it:

```bash
npm install -g pll-python
pll hw.py
```

## Language levels

The level comes from the file's own first line, exactly as in the editor:

```python
#level beginner

greeting = "Hello!"
print(greeting)
```

| Line in the file | What it does |
| --- | --- |
| `#level raw` | Nothing checked. Plain Python plus PLL's libraries. This is what you get with no line at all. |
| `#level beginner` | Warns about reassigning a variable, hiding another name (a built-in like `list`, or one of PLL's own like `circle`), and `global` / `nonlocal`. Type annotations are checked as the program runs. If it finds a problem, the file does **not** run. |
| `#level intermediate` | Same, but reassignment is allowed inside a function. |
| `#level advanced` | No pre-run checks; annotations still checked, by Python's own rules. |

There is deliberately **no flag to override the level**. A file behaves the
same way everywhere, which is the point of putting it in the file.

## Tests

`test_*` functions in the same file run once the program finishes, against
what it defined, as they do in the editor:

```bash
pll hw.py            # the program, then its tests
pll hw.py --no-tests # just the program
```

## Options

```
--no-tests           do not run the file's test_* functions first
--save-images <dir>  write pictures there as .svg
-q, --quiet          only the program's own output
--no-color           never use ANSI colour
-h, --help
-v, --version
```

## Authoring Examplar bundles

Examplar assesses a *test suite* rather than an implementation: students
write tests first, and those tests are run against known-good
implementations (**wheats**), where they must all pass, and known-bad ones
(**chaffs**), where each must be caught by at least one failing test.

There is a complete worked example in the repository, with a student file,
two wheats, six chaffs and a staff suite:
[`samples/examplar_bundle/`](https://github.com/dbp/pll/tree/main/samples/examplar_bundle).

Lay the implementations out one file each:

```
hw3/
  wheats/reference.py       known-good; every test must pass on these
  wheats/alternative.py     more than one stops tests over-fitting
  chaffs/shout/1.py         known-bad; each must be caught by some test
  chaffs/shout/2.py
  chaffs/total/1.py
```

A chaff goes in a directory named after the function it breaks: the
student's report is one card per function, and that directory is how you say
which card it belongs on. Every function needs at least one chaff, or its
card could never say anything about how thorough their tests are.

Every wheat and chaff has to define the same functions, since a suite is run
against all of them interchangeably. Then:

```bash
pll examplar build hw3/ -o hw3.json --verify staff_tests.py
```

Only bytecode goes into the bundle, so your sources stay in your
repository. It is compiled by the Pyodide this package pins, which is why
bundles are built with this tool and not a local `python` — bytecode is tied
to the Python version, and this way it matches by construction.

`--verify` runs your own suite against the bundle and refuses to write it
unless the suite passes on every wheat and **fails on every chaff**. A chaff
no test can catch would silently never count for anyone:

```
verifying with staff_tests.py:
  ok    wheat reference: all 2 pass
  ok    chaff shout/1: caught by test_shout_excites
  BAD   chaff shout/2: no test catches it - it would never count
  BAD   your own suite has no tests for total, so its chaffs are unproven
pll: 2 problem(s) with this bundle; not written.
```

A function your own suite never touches fails too. Its chaffs are never run,
so nothing has shown they are catchable — the same hazard as a chaff no test
can catch, arrived at from the other direction.

It also catches a staff test that is itself wrong, since that shows up as a
wheat failure — with pytest's rewritten assertion, which is the whole point.
(Students never see this; their card names the failing test and stops there,
because the assertion states the correct answer. Here the reader is you, and
there is nothing to give away.)

```
  BAD   wheat reference: your own tests do not all pass on it
          test_shout: assert 'HI!' == 'hi!'
  ---   shout chaffs not checked: its tests have to pass first
```

Those chaffs are not checked, here or for students: a suite that is wrong
fails on every chaff, so its coverage would measure the bug rather than the
suite. The same goes for a test that *errors* — nothing short of a pass
counts. It is decided per function, so `total` above is still scored.

A chaff's id is its filename, and it is the **only** thing a student is told
about a chaff they missed. `chaffs/shout/off-by-one.py` therefore hands over
the test they were meant to write; number them (`chaffs/shout/1.py`) unless
the name is genuinely uninformative. Numbering restarts in each directory,
since the card is already about one function. Wheat ids are harmless — those
are correct code.

Publish the bundle at a URL and point students at it from their file:

```python
#level beginner
#examplar https://cs2000.example/hw3.json
```

The check runs wherever the file does - in the editor, and with `pll
hw3.py`, which prints the same cards to stderr. Fetched bundles are cached
(under `$PLL_CACHE_DIR`, `$XDG_CACHE_HOME` or `~/.cache`), so a run without a
network still gets its verdict. The verdict does not change the exit code.

If any of your students use **vscode.dev** or a codespace, the extension host
there is a browser, so serve the bundle with CORS
(`samples/examplar_serve.mjs` in the repository is a dependency-free server
that gets these right):

```
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: ETag
Access-Control-Allow-Headers: If-None-Match
```

The last two matter more than they look. Without `Expose-Headers` the ETag is
invisible to script, so nothing is ever cached; without `Allow-Headers` the
conditional request fails its preflight, so students stay on whatever copy
they fetched first and never see a bundle you republish. Neither failure
reports itself.

Only their **definitions** run during the check — not their program — so a
`print` or an `input()` at the bottom of a student's file cannot disturb it,
and it is not run once per implementation. The workspace is unmounted while
it runs, so a test that opens a data file cannot work there; the card tells
the student that instead of claiming the test is wrong.

Students see one card per function, headed by the function name, with a
line for each phase: *"Against correct implementations: ..."* and
*"Against buggy implementations: ..."*. Neither gives anything away — the
first names a test that disagrees but not what it should have said, and the
second gives a chaff's id and nothing else. A chaff is judged only by the
tests of its own function, so a broken test of one function cannot flatter
or hold up another.

Bytecode hides the implementations from `inspect.getsource` and nothing
more — `dis` still tells the whole story to anyone who looks. That is a
deliberate trade: the autograder holds the grade, so this check is there to
be fast and honest rather than secret.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Ran, and any tests passed |
| 1 | The program raised, or Ctrl+C stopped it |
| 2 | Level checks found problems, so it was not run |
| 3 | A test failed |
| 64 | Bad usage, or PLL could not start |

Distinct codes so an autograder can tell "the level rejected this" from
"the tests failed" from "it crashed".

A program that ends itself with `sys.exit(n)` exits with `n` instead, as it
would under `python` - so a program can produce any of these codes itself.
`sys.exit()` is 0, and `sys.exit("message")` prints the message and is 1.
A status other than 0 outranks a failed test's 3.

## Piping

The program's own stdout is the **only** thing on stdout. Everything
`pll` says about the run — the level, findings, test results, banners —
goes to stderr. So this captures exactly what the program printed:

```bash
pll hw.py > output.txt
```

`input()` reads stdin, so piping works too:

```bash
printf 'Ada\n' | pll greet.py
```

## What differs from the editor

- **Pictures cannot be drawn in a terminal.** Each one prints a note with
  its size; `--save-images` writes them as `.svg` instead.
- **Reactors (`big_bang`, `animate`) do not run.** They need the editor's
  interactions panel to animate; here they print a note and the rest of the
  program continues. Their logic is still testable — `simulate_trace(n)`
  works fine and needs no clock.
- **Tables do print**, as text. Their content is already text, so there is
  nothing to lose.

Everything else is the same code: the same Pyodide worker, the same Python
libraries, the same analyzers and the same wording for errors.

## Files next to your program

`open("data.csv")` and `pd.read_csv("data.csv")` read files in the same
folder as the script, and files the program writes appear there afterwards —
the same as in the editor.

## Licence

MIT
