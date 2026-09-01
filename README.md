# Python Language Levels (PLL)

PLL is a VS Code extension for learning Python. It runs your programs
inside the editor and shows the results in an **interactions** panel —
output, errors, images, tables, and a prompt where you can try extra
Python after a run.

It works in [vscode.dev](https://vscode.dev) (in the browser) and in
desktop VS Code. You do **not** need to install Python on your computer.

## Install

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

When you click **PLL: Run Python File**, PLL runs the tests first and
shows a pass/fail card in the interactions panel. If a test fails, you
can click it to jump to that test. After the tests, PLL still runs the
rest of the file so you can use your functions at the prompt.

You do not need a separate test file, and you do not need to run
`pytest` in a terminal.

For decimal (floating-point) numbers, exact `==` can be unreliable.
Import `pytest` and use `pytest.approx`:

```python
import pytest

def test_cost():
    assert 0.1 + 0.2 == pytest.approx(0.3)
```

## Language levels

The first non-blank line of a file can choose how strict PLL is. After
you run the file, the current level is shown in the interactions header
(for example `hello.py [beginner]`).

```python
#beginner
```

| Line in your file | What it does |
| --- | --- |
| `#beginner` | Strictest. PLL warns about reassigning a variable, reusing a name that hides another name (including built-in names like `list`), and the `global` / `nonlocal` keywords. If it finds a problem, it **does not run** the file. |
| `#intermediate` | Same rules about hiding names and `global` / `nonlocal`, but you **may** reassign variables inside a function. That is useful for introducing for loops, where you need mutable accumulators. Reassigning at the top of the file is still flagged. |
| `#advanced` | No extra checks. The file runs as ordinary Python. This is the default if you omit the line. |

The prompt at the bottom of the interactions panel uses the **same**
level as the last run (the one shown in the header). If you have not
run the file yet, the prompt is advanced.

## Interactive `input()`

In the **browser** (vscode.dev, or `pnpm run test-web`), `input()` asks
for a line in the interactions panel. The prompt string prints first,
then you type a reply and press Enter. **Ctrl+C** (with nothing
selected) cancels and the program gets an `EOFError`.

```python
name = input("What is your name? ")
print("Hello,", name)
```

On **desktop VS Code**, `input()` is not supported yet (it would freeze
the editor). PLL raises a `RuntimeError` that tells you to use
vscode.dev instead.

## Images

You can make pictures with built-in functions. You do not need to
`import` anything. If a line in your file produces an image, PLL shows
it in the interactions panel, in order with any `print` output.

```python
#beginner

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

**Size:** `image_width`, `image_height`, `empty_image`.

Colors can be names (`"red"`), hex (`"#ff0000"`), or tuples
`(red, green, blue)` with values from 0 to 255.

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

Tables show up as a card you can scroll, with a **Save CSV** button.
Charts show up as images.

Useful methods include `filter`, `transform_column`, `add_column`,
`order_by`, `select_columns`, `head`, `columns`, `length`, `row`,
`column`, `sum`, `mean`, `min`, and `max`. Charts: `bar_chart`,
`scatter_chart`, `line_chart`, `histogram`.

If you already know pandas, `my_table.to_pandas()` gives you a DataFrame.

## Friendlier errors

If you use a name that is not defined, PLL rewrites Python's `NameError`
into a short explanation of **what** went wrong, **why**, and **how to
fix it**. The message appears in the interactions panel and as a mark
in the editor. Click the location in the message to jump to that line.

## Commands

All of these are available from the Command Palette. **PLL: Run Python File**
also appears in the editor title bar when a `.py` file is open.

| Command | What it does |
| --- | --- |
| **PLL: Run Python File** | Run tests (if any), then run the file. |
| **PLL: Show Interactions** | Open the interactions panel. |
| **PLL: Start REPL** | Open the interactions panel (same as Show Interactions). |
| **PLL: Clear Interactions** | Clear the panel. |

## A quieter editor

PLL turns off many extra Python tools (autocomplete popups, extra
linters, and similar) so the editor stays simple while you are learning.
Settings you choose yourself still win over PLL's defaults.

If another Python extension is installed and might add confusing
messages, PLL may ask whether to disable it **for this workspace**. That
does not uninstall the extension.

## For course staff and contributors

How PLL is built, how to run it from source, and how the editor
defaults work are documented in [ARCHITECTURE.md](ARCHITECTURE.md).
