# Python Language Levels (PLL)

PLL is a VS Code extension for learning Python. It runs your programs
inside the editor and shows the results in an **interactions** panel —
output, errors, images, tables, and a prompt where you can try extra
Python after a run.

It works in [vscode.dev](https://vscode.dev) (in the browser) and in
desktop VS Code. You do **not** need to install Python on your computer.

## Install

PLL needs VS Code **1.101 (June 2025) or newer**. If you are installing VS
Code now, you have it; if yours is older, update it first.

1. Open VS Code (desktop or [vscode.dev](https://vscode.dev)).
2. Open the Extensions view (the four squares in the left sidebar).
3. Search for **Python Language Levels**.
4. Click **Install**. If you are asked to trust the publisher, do that.

You do **not** need Microsoft's **Python** extension. If VS Code offers
to install it, you can skip it. PLL is enough.

## Run a program

1. Create a file whose name ends in `.py`, for example `hello.py`.
2. Type a small program:

   ```python
   print("hello")
   ```

3. Look at the top right of the editor, on the same bar as the file name.
   Click **PLL: Run Python File**.

   If you do not see that text, open the Command Palette
   (`Ctrl+Shift+P` on Windows, `Cmd+Shift+P` on a Mac) and run
   **PLL: Run Python File**.

The first run can take a little while: PLL is starting Python in the
editor. Later runs are faster.

Your file stays a normal editor. Results appear in the **PLL** panel at
the bottom of the window (near Problems and Terminal). If that panel is
hidden, run **PLL: Show Interactions** from the Command Palette.

### Before you have a file

With no Python file open, the PLL panel has a session of its own, called
**No file**: type Python at its prompt and press Enter. It is for the very
first things you try - on vscode.dev, before you have a repository to make
a file in. It always uses `#level beginner`. It has no folder, so it cannot
read files next to a program (a table or picture from a URL still works),
and a file it writes is not saved.

Once you open a Python file, the panel shows that file's session instead.
**PLL: Start REPL** switches back to the session with no file, which keeps
what you typed in it until the window closes - or until you clear it
(**Ctrl+L**, or the Clear button), which starts it afresh: nothing typed in
it before is defined any more.

### Try things after a run

The interactions panel has a prompt at the bottom. After a file has
run, you can type extra Python there and press Enter. Names you defined
in the file are still available. The prompt uses the same language
level as that run (the one shown in the header).

- **Enter** runs what you typed.
- **Shift+Enter** adds another line (for a longer snippet).
- If Python is waiting for more input (for example after `if True:`),
  PLL will keep prompting until the snippet is complete.
- **Up** and **Down** move through things you typed earlier.
- **Ctrl+L** (Windows) or **Cmd+L** (Mac) clears the interactions panel.
  You can also run **PLL: Clear Interactions**.

### Stopping a program

If a program runs longer than you expect - a loop that never ends, say -
click **Stop** in the interactions panel. **Ctrl+C** (with nothing selected)
and **PLL: Stop Program** in the Command Palette do the same thing. The
program stops with a `KeyboardInterrupt`, and anything it printed first is
kept.

Stop works the same way while your tests run. The test that was running is
marked as stopped, and the rest of the tests do not run.

This works for ordinary Python code. If your program is stuck inside a
library (a very long `pandas` operation, for example), or if it catches
`KeyboardInterrupt` itself, PLL will tell you it could not stop it - reload
the window in that case.

## Language levels

The first non-blank line of a file chooses how strict PLL is. After you
run the file, the current level is shown in the interactions header (for
example `hello.py [beginner]`).

```python
#level beginner
```

Write it exactly like that, in lower case, as the first line that is not
blank.

| Line in your file | What it does |
| --- | --- |
| `#level raw` | Nothing is checked. Your program runs exactly as plain Python would, with PLL's built-in libraries (images, tables) and the interactions panel still available. **This is what you get if you leave the line out.** |
| `#level beginner` | Strictest. PLL warns about reassigning a variable, reusing a name that hides another name (a built-in like `list`, or one of PLL's own like `circle`), and the `global` / `nonlocal` keywords. If it finds a problem, it **does not run** the file. Type annotations are checked as the program runs. |
| `#level intermediate` | Same rules about hiding names and `global` / `nonlocal`, but you **may** reassign variables inside a function. That is useful for introducing for loops, where you need mutable accumulators. Reassigning at the top of the file is still flagged. Annotations are checked. |
| `#level advanced` | No extra checks before the file runs. Annotations are still checked as the program runs, but by Python's own rules (so `True` counts as `1`). |

The level is the only thing that decides what gets checked — there is no
separate setting to keep in sync with it.

Each file keeps its own level when another file imports it. If `main.py`
does `from helper import half` and `helper.py` starts with `#level
beginner`, then `helper.py` is checked as a beginner file, whatever level
`main.py` has: if the checks find a problem in it, the import stops with a
`ChecksFailed` error that lists each problem, and its annotations are
checked as it runs. (So a grading script can import a student's file and
get the student's level.)

If your course sets `pll.newFileLevel`, every new `.py` file you create
starts with that level line already written in, so you do not have to
remember it. You can always change or delete the line.

The prompt at the bottom of the interactions panel uses the **same**
level as the last run (the one shown in the header). If you have not run
the file yet, it uses the level the file's `#level` line names.

## Type annotations are checked as your program runs

If you write annotations, PLL checks them while the program runs and stops
with an explanation the moment a value does not match:

```python
def book_cost(num_books: int, hardcover: bool) -> float:
    if hardcover:
        return num_books * 25
    return num_books * 12

book_cost("three", True)
```

> `book_cost` expects `num_books` to be a whole number (`int`), but got a
> string (`str`).

You do not need to import anything, and it works at every level except
`#level raw`. What is checked:

- the arguments you pass to a function, checked at the call
- the value a function returns, including a function that ends without
  returning anything when it says it returns something
- variables you annotate, like `total: int = 0`
- every item in an annotated `list`, `dict`, `set`, or `tuple`

Functions without annotations are left completely alone. A whole number is
accepted wherever a `float` is expected, as it is in normal Python.

At `#level beginner` and `#level intermediate`, `True` and `False` are
**not** accepted where `int` or `float` is annotated:

```python
#level beginner

shelf_count: int = True   # error: True is not a whole number here
```

Python itself counts `True` as `1`, so this is a rule PLL adds rather than
one Python enforces — a value that is really a yes/no answer should be
annotated `bool`. At `#level advanced` this follows Python's own rule and is
allowed.

To turn annotation checking off entirely, write `#level raw` at the top of
the file (or leave the level line out).

## Tests

You can put tests in the **same file** as the code they check. A test is
a function whose name starts with `test_`. Use `assert` to check that
something is true:

```python
def add(x, y):
    return x + y

def test_add():
    assert add(2, 3) == 5
```

When you click **PLL: Run Python File**, PLL runs your file, and then its
tests, and shows a pass/fail card in the interactions panel after what the
program printed. The tests see everything the file defined. If a test
fails, you can click it to jump to that test. If the program stops with an
error, or ends itself with `sys.exit()`, the tests are not run, and PLL
says so.

You do not need a separate test file, and you do not need to run
`pytest` in a terminal.

For decimal (floating-point) numbers, exact `==` can be unreliable.
Import `pytest` and use `pytest.approx`:

```python
import pytest

def test_cost():
    assert 0.1 + 0.2 == pytest.approx(0.3)
```

## Checking your tests against your course's code

Some assignments ask you to write the **tests first**, before the code. There
is nothing of your own to run them against yet — so PLL can run them against
code your course wrote: implementations known to be correct, and
implementations known to contain a bug.

Your course gives you a line to put at the top of the file:

```python
#examplar https://example.edu/hw3.json
```

After that, every run adds a card for each function the assignment asks for:

```
total                                                        Examplar
  Against correct implementations: all 3 of your tests pass.
  Against buggy implementations: caught 4 of 6 - missed 2, 5.
```

The first line asks whether your tests are **right** — do they agree with
code that works? The second asks whether they are **thorough** — how many of
the deliberately broken versions did they notice? One `test_` function is
enough to start; you do not need to have written any of the assignment.

**It will not tell you the answer.** If a test expects the wrong thing you
are told *which* test, never what it should have said — otherwise you could
read the assignment straight off the card, one deliberately-wrong test at a
time. A buggy version you missed gives up its number and nothing else.
Working out what you failed to check is the exercise.

Coverage only appears once every test of that function passes, because a
wrong test fails on the buggy versions too and would look as though it had
caught them. Each function is scored on its own, and one you have not
started says simply "No tests yet."

Two things to know. Your program does not run during the check — only your
definitions are loaded, so a `print` at the end of your file still happens
once, right afterwards. And files next to your program are not available
during it, so a test that opens `data.csv` cannot run there; the card says
so rather than calling that test wrong.

None of this is a grade. It shows you where your tests are thin while you
still have time to do something about it.

## Images

You can make pictures with built-in functions. You do not need to
`import` anything. If a line in your file produces an image, PLL shows
it in the interactions panel, in order with any `print` output.

```python
#level beginner

circle(50, "solid", "red")

beside(
    triangle(60, "solid", "gold"),
    square(60, "outline", "navy"),
)
```

Each picture has a **Save SVG** button if you want to keep it.

**Shapes:** `circle`, `square`, `rectangle`, `ellipse`, `triangle`,
`right_triangle`, `regular_polygon`, `star`, `star_polygon`, `line`,
`text`.

**Combining and transforming:** `beside`, `above`, `overlay`, `underlay`,
`rotate`, `scale`, `flip_horizontal`, `flip_vertical`.

**Placing things exactly:** `overlay_xy` and `underlay_xy` move the *second*
image by an offset — `overlay_xy(a, 20, 10, b)` puts `b` 20 to the right and
10 down from `a`. Negative offsets move it left or up, and the picture grows
that way rather than cutting anything off.

**Choosing which edges line up:** `beside_align("top", ...)`,
`above_align("left", ...)`, `overlay_align("right", "bottom", ...)`, and
`underlay_align`. Horizontal positions are `"left"`, `"center"`, `"right"`;
vertical are `"top"`, `"center"`, `"bottom"`.

**Scenes:** `empty_scene(width, height)` is a fixed-size canvas, and
`place_image(image, x, y, scene)` puts an image's **center** at that point
on it, cropping anything past the edge. `crop(x, y, width, height, image)`
takes a piece out of an image, and `frame(image)` outlines its edges.

**Size:** `image_width`, `image_height`, `empty_image`.

The shapes are drawn as 2htdp/image draws them: an outline is a 1-pixel
pen just inside the shape, a rotated picture's box is the box of the turned
shapes (so a circle turned is as wide as it was), `star` and
`star_polygon` are true star polygons, and `right_triangle`'s right angle
is at the bottom left. `text` is set in a monospace font, so its size is
exact and its spaces are kept.

Two pictures are `==` when they draw the same shapes in the same places in
the same colours, however they were built - so a test can compare what a
function draws with what it should:

```python
def test_dot():
    assert dot(3) == circle(3, "solid", "red")
```

Colors can be names (`"red"`), hex (`"#ff0000"`), `"rgb(255, 0, 0)"` or
`"hsl(0, 100%, 50%)"`, or tuples `(red, green, blue)` with values from 0 to
255. A fourth number is how solid it is: a whole number from 0 to 255, or a
fraction from 0.0 to 1.0, so `(255, 0, 0, 128)` and `(255, 0, 0, 0.5)` are
both half see-through. Names are checked against the CSS colours, which are
the names a browser understands, so a misspelling is an error that suggests
what you meant (`"rd"` → "Did you mean `red`?", `"light blue"` → "Did you
mean `lightblue`?") rather than an invisible shape. `"transparent"` works
too.

### Loading a picture

`load_image` reads a picture from a file next to your program or from an
address, working out which from what you give it:

```python
cat = load_image("cat.png")
cat = load_image("https://example.edu/cat.png")
```

It gives you an ordinary picture, so everything above works on it —
`scale`, `rotate`, `beside`, `place_image` and the rest. PNG, JPEG, GIF,
WebP and SVG files are understood, up to 2 MB each, from a file or an
address — these are for the graphics a program draws with, not for
photographs.

## Tables and charts

PLL also includes a `table` type (again, no import). Tables do not
change in place: each operation returns a **new** table.

```python
people = table(
    ["name", "age"],
    [
        ["Ada", 36],
        ["Grace", 85],
    ],
)

people
people.bar_chart("name", "age", title="Age")
```

Tables show up as a card you can scroll, with a **Save CSV** button, which
saves the whole table, every row and every digit. A number is shown as
Python prints it (`12999.99`, `2.0`), and columns of numbers line up on the
right - so a column of numbers that is still text, from a CSV, can be seen
to be. Charts are pictures: they show up as images, and `beside`, `above`
and the rest work on them.

### Loading a CSV

`load_table` reads a CSV, either from a file next to your program or from
an address — it works out which from what you give it:

```python
cars = load_table("cars.csv")
cars = load_table("https://example.edu/cars.csv")
```

The first row names the columns, and **every value arrives as text** —
including the ones that look like numbers. An empty cell is `""`. A file
saved by Excel is read either way: "CSV UTF-8", and a plain "CSV" in
Windows-1252, which PLL says it has done. Convert a column when you want to
chart it or average it:

```python
cars = load_table("cars.csv").transform_column("mpg", float)
cars.histogram("mpg")
```

That is one more line than guessing which columns are numbers, and it is
the line that says what you meant: a column of years or postcodes is not
something to do arithmetic on, and one stray `n/a` would otherwise change
what the whole column holds.

### Methods

Useful ones include `filter`, `transform_column`, `add_column`,
`add_row`, `order_by`, `select_columns`, `head`, `columns`, `length`,
`row`, `column`, `sum`, `mean`, `min`, and `max`. For a median, a standard
deviation or anything else of that sort, use a column with Python's own
`statistics` module. A row is a `Row`, which is a `dict`.

`sum` of whole numbers is a whole number. At `beginner` and `intermediate`,
`True` and `False` are not numbers to `sum` and `mean`. `min`, `max` and
`order_by` refuse a column of numbers that is still text when comparing it
as text would give a different answer (`"9"` comes after `"100"`), and say
to convert it first.

Two tables are `==` when they have the same columns, in the same order,
holding the same values — so you can test a function that builds a table
by comparing it with the table you expect. When such a test fails, it says
which row is the first to differ.

### Charts

| Chart | What it shows |
| --- | --- |
| `bar_chart(labels, values)` | one bar per row |
| `freq_bar_chart(column)` | one bar per distinct value, counting the rows |
| `pie_chart(labels, values)` | each row's share of the total |
| `scatter_plot(x, y)` | one point per row |
| `line_chart(x, y)` | points joined in order of `x` |
| `dot_plot(column)` | one dot per row, stacked where rows share a value |
| `box_plot(column)` | quartiles, whiskers and outliers |
| `histogram(column)` | counts per bucket — `bins=` how many, or `bin_width=` how wide |
| `lr_plot(x, y)` | a scatter plot with the line of best fit, and r² in the title |

`labeled_scatter_plot`, `labeled_dot_plot` and `labeled_lr_plot` take an
extra first argument: a column to colour the points by, with a key. Every
chart takes an optional `title=`. `linear_regression(x, y)` gives you the
slope, intercept and r² as numbers instead of a picture.

To draw a function rather than a table, `function_plot` takes the function
and the range to draw it over:

```python
function_plot(lambda x: x * x, -3, 3)
```

If you already know pandas, `my_table.to_pandas()` gives you a DataFrame.
You can also `import pandas as pd` and read a CSV from a URL with
`pd.read_csv("https://...")`, and `urllib` and `requests` work too. That
works in desktop VS Code, on the command line and in the browser. An
address that answers with an error (a 404) raises `HTTPError`, as in
Python; one that does not answer at all gives up after 60 seconds, or the
`timeout` a program gives, and Stop ends the wait. In the browser, the site
must allow cross-origin requests (CORS) — the same goes for `load_table`
with an address.

### Charts with matplotlib

`import matplotlib.pyplot as plt` works too: `plt.show()` shows each figure
in the panel as a picture, and so does a figure on a line of its own at a
student level. The text and lines `plt.title(...)` or `plt.plot(...)` give
back are not printed.

### Packages

A program can import any package Pyodide has - numpy, pandas, matplotlib,
requests, scipy and many more. PLL finds them before the program runs, from
its imports wherever they are, and from those of the files of yours it
imports; the first time, it downloads them, which needs the network. A
package Pyodide does not have (`flask`) is said to be one, rather than
left as `No module named 'flask'`.

## Animations and interactive programs

A **reactor** is an interactive program: a starting state, a function that
draws it, and functions that change it when something happens. It shows up
as a card right in the interactions panel.

The quickest way in is `animate`, where the state is just a frame counter:

```python
scene = empty_scene(320, 140)

animate(lambda n: place_image(circle(14, "solid", "crimson"), (n * 4) % 320, 70, scene))
```

The long form names each handler:

```python
reactor(
    init=(160, 70),
    to_draw=lambda spot: place_image(star(18, "solid", "gold"), spot[0], spot[1], scene),
    on_key=move,          # move(state, key) -> new state
    title="Arrow keys",
).interact()
```

| Handler | Called with | When |
| --- | --- | --- |
| `to_draw` | `(state)` | every frame; must return an image |
| `on_tick` | `(state)` | on the clock |
| `on_key` | `(state, key)` | a key press — `"left"`, `"a"`, `" "`, … |
| `on_mouse` | `(state, x, y, event)` | `"button-down"`, `"button-up"`, `"drag"`, `"move"`, `"enter"`, `"leave"` |
| `stop_when` | `(state)` | after each change; `True` ends it |
| `on_receive` | `(state, message)` | a message from a server (see below) |

Also `tick_rate` (seconds between ticks, default about 1/28) and `title`.
Each handler returns the **new state**. Click the picture before using the
keyboard, so the keys go to the reactor and not the prompt.

### Playing, pausing, and rewinding

The card has play / pause, a single-step button, and a slider. Every state
the reactor passes through is recorded, so you can drag the slider back to
watch what happened and then play forward again from there.

`big_bang(init, ...)` is the same as `reactor(...).interact()`.

### Testing a reactor without watching it

A reactor is a value, so you can run it without any of the animation:

```python
countdown = reactor(init=10, to_draw=..., on_tick=lambda n: n - 1,
                    stop_when=lambda n: n <= 0)

countdown.simulate_trace(20).get_trace()   # [10, 9, 8, ..., 0]
countdown.get_value()                      # 10 — the original is unchanged
countdown.react({"kind": "tick"}).get_value()   # 9
```

`react` returns a *new* reactor, so this works in tests and at the prompt.

## Talking to a universe server

A reactor with a `register` address is a **world**: it connects to a server
and can send and receive messages.

```python
reactor(
    init=...,
    to_draw=...,
    on_key=lambda state, key: package(new_state, {"at": [x, y]}),
    on_receive=lambda state, message: ...,
    register="ws://localhost:8080",
).interact()
```

`package(state, message)` returns the new state **and** sends a message.
Whatever the server sends back arrives at `on_receive`. The card shows
whether it is connected.

You write worlds; the server is a separate program your course runs, in
whatever language they like. Messages are JSON, one value per message, in
each direction — so a conforming server is small, and your course will give
you one to run.

In the browser, a page served over `https` (including vscode.dev) can only
reach a `wss://` address — except on `localhost`, which is allowed either
way.

## Interactive `input()`

`input()` asks for a line in the interactions panel, in desktop VS Code
and in the browser. The prompt string prints first, then you type a
reply and press Enter. **Ctrl+C** (with nothing selected) cancels and
the program gets an `EOFError`.

```python
name = input("What is your name? ")
print("Hello,", name)
```

## Files next to your program

`open("data.csv")` and `pd.read_csv("data.csv")` read files that sit in
the **same folder** as the `.py` file you ran, or in a folder inside it:
`open("data/2024.csv")`. That works in desktop VS Code and in the browser
(including vscode.dev). Files are read exactly as they are on disk, so a
CSV saved in another encoding, or a picture, arrives intact.

After the program finishes, files it wrote or changed — for example
`to_csv("out.csv")` or `open("results/out.csv", "w")` — show up in that
folder, and a file it deleted is deleted. You can open them in the editor.
Some are never saved, and the panel names each one and why ("Not saved:
..."):

- your `.py` files, which PLL never overwrites or deletes;
- a file the program was not given (too big, say) — saving what it wrote
  would replace a file it never saw;
- a file that changed while the program ran, or that is open in the
  editor with changes you have not saved.

Untitled editors (not yet saved to a folder) have no files around them to
load or save.

There are limits: at most 100 files are loaded, each at most 2 MB and 8 MB
in all - those nearest the program first - and the same for the files
saved afterwards. Hidden folders (`.git`) and tools' folders (`venv`,
`node_modules`, `__pycache__`) are left out. A file left out by a limit is
named in the panel ("Not loaded: ... - each file can be at most 2 MB."),
so a program that cannot open or import it is not left failing for no
reason you can see.

## Friendlier errors

If you use a name that is not defined, PLL rewrites Python's `NameError`
into a short explanation of what went wrong and **how to fix it**. The
message appears in the interactions panel and as a mark in the editor.
Click the location in the message to jump to that line.

## Commands

All of these are available from the Command Palette. **PLL: Run Python File**
also appears in the editor title bar when a `.py` file is open.

| Command | What it does |
| --- | --- |
| **PLL: Run Python File** | Run tests (if any), then run the file. |
| **PLL: Show Interactions** | Open the interactions panel. |
| **PLL: Start REPL** | Show the session with no file, at `#level beginner`, whatever file is open. |
| **PLL: Stop Program** | Stop the program that is running. |
| **PLL: Clear Interactions** | Clear the panel. |

## Copy and paste

Ctrl/Cmd+C, X, and V work as usual, both in the editor and in the
interactions panel, in the browser and on the desktop. Right-click also
works.

If the shortcuts do nothing in the browser and you use a layout other
than QWERTY (Dvorak, Colemak, …), add this to your **user** settings
(Command Palette → *Preferences: Open User Settings (JSON)*) — a
`.vscode/settings.json` in the folder will not work:

```json
{
  "keyboard.dispatch": "keyCode"
}
```

Otherwise, check whether something in your own **Keyboard Shortcuts**
has taken over Ctrl/Cmd+C or V. **PLL: Editor Copy/Cut/Paste** in the
Command Palette also work as a fallback.

## A quieter editor

PLL turns off many extra Python tools (autocomplete popups, extra
linters, and similar) so the editor stays simple while you are learning.
Settings you choose yourself still win over PLL's defaults.

If another Python extension is installed and might add confusing
messages, PLL may ask whether to disable it **for this workspace**. That
does not uninstall the extension.

## Running programs without the editor

The same language levels are available as a command-line tool, so a program
behaves the same on a terminal as it does in the panel:

```bash
npx pll-python hw.py
```

The level still comes from the file's own `#level` line, an `#examplar` line
still checks your tests, tests still run after the program, and errors are
worded the same way. Pictures cannot be drawn in a
terminal (each prints a note, or use `--save-images`) and reactors do not
animate, but tables print as text and everything else is the same code.

Exit codes make it usable for marking: `0` ran and tests passed, `1` the
program raised or was stopped, `2` level checks blocked it, `3` a test
failed. A program that ends itself with `sys.exit(n)` exits with `n`, as
under `python`.

Course staff can also build Examplar bundles with it. See
[pll-python on npm](https://www.npmjs.com/package/pll-python) for that and
the full list of options.

## For course staff and contributors

How PLL is built, how to run it from source, how to author Examplar
bundles, and how the editor defaults work are documented in the
[repository](https://github.com/dbp/pll).
