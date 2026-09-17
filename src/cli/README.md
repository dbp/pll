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
| `#level beginner` | Warns about reassigning a variable, hiding another name (including built-ins like `list`), and `global` / `nonlocal`. Type annotations are checked as the program runs. If it finds a problem, the file does **not** run. |
| `#level intermediate` | Same, but reassignment is allowed inside a function. |
| `#level advanced` | No pre-run checks; annotations still checked, by Python's own rules. |

There is deliberately **no flag to override the level**. A file behaves the
same way everywhere, which is the point of putting it in the file.

## Tests

`test_*` functions in the same file run before the file does, as they do in
the editor:

```bash
pll hw.py            # tests, then the program
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

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Ran, and any tests passed |
| 1 | The program raised |
| 2 | Level checks found problems, so it was not run |
| 3 | A test failed |
| 64 | Bad usage, or PLL could not start |

Distinct codes so an autograder can tell "the level rejected this" from
"the tests failed" from "it crashed".

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
