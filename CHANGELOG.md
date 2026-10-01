# Changelog

## Unreleased

### Fixed
- **A name used before it had a value was not named.** Python words that one
  as `cannot access free variable 'title' ...`, which PLL did not recognise,
  so the report read "Python doesn't know what `this name` means" — in a file
  where `title` is right there. It now names the variable, and says to move
  the line that sets it rather than to check a spelling that was already
  correct. `UnboundLocalError` is explained too, where before it fell
  through to a bare traceback.

## 0.2.0 (2026-09-30)

### Breaking
- **A colour or a draw mode that is not one has become an error.** Before,
  `rectangle(30, 40, "solid", 50)` drew an invisible shape and a misspelled
  `"outilne"` quietly filled it in; both now stop the file with a message
  naming the call. A file that was relying on either was not drawing what it
  looked like it was, but it did run, and now it will not.
- **`regular_polygon` is oriented differently for an even number of sides.**
  It sits on a side rather than on a vertex, so `regular_polygon(40, 4, ...)`
  is now a 40x40 square where it used to be a 57x57 diamond.

### Added
- **`load_table(source)`** reads a CSV from a file next to your program or
  from an `https://` address, working out which from the text. Every cell
  arrives as text, as in Pyret; convert a column with
  `transform_column("mpg", float)`.
- **`load_image(source)`** does the same for a picture — a file or an
  address — and gives back an ordinary image, so every combinator works on
  it. PNG, JPEG, GIF, WebP and SVG.
- **Charts to match the Pyret charting library**: `pie_chart`,
  `freq_bar_chart`, `dot_plot`, `labeled_dot_plot`, `box_plot`, `lr_plot`,
  `labeled_scatter_plot`, `labeled_lr_plot`, `scatter_plot` (an alias for
  `scatter_chart`), and module-level `function_plot(f, x_min, x_max)`.
  `histogram` now takes `bin_width=` as well as `bins=`, and
  `linear_regression(x, y)` gives the slope, intercept and r² as numbers.
- **Tables compare with `==`** — same columns in the same order holding the
  same values — so a function that builds a table can be tested by
  comparing it with the expected one. `repr` now shows the rows rather than
  just the shape, because that is what a failed comparison prints.
- **Pictures next to your program are mounted**, so `load_image("cat.png")`
  works on a local file. Same size limits as the data files, and a picture
  is never written back.

### Fixed
- **Recursive data crashed the test phase.** A dataclass with a string
  forward reference (`rest: "NumList"`) died with
  `AttributeError: 'NoneType' object has no attribute '__dict__'`, because
  the tests ran under a module name that was never registered.
- **Dataclass fields were not type-checked.** `@dataclass` writes `__init__`
  after the type checker has seen the file, so `Dog(5, 3)` with `name: str`
  was accepted silently. Recursive fields are checked too.
- **A dataclass field named `id` was reported as shadowing a built-in.** A
  name in a class body is a field, not a variable. A class *named* after a
  built-in is still caught.
- **A non-colour was accepted silently.** `rectangle(30, 40, "solid", 50)`
  drew an invisible shape; it is now an error that names the call. The same
  went for a misspelled mode (`"sloid"`). A misspelled colour *name* still
  draws nothing — PLL does not keep a list of colour names.
- **Type errors inside tests showed typeguard's own wording** ("is not an
  instance of str") instead of PLL's, in both the editor and the command
  line.
- **`pll` dropped a failing test's printed output**, which the editor shows —
  so a `print` added to see what a function returned was invisible there.
- **`pll` printed a `NameError`'s column as `:NaN`.**
- **A URL read through the desktop host corrupted bytes above 0x7f.** The
  XHR shim decoded bodies as windows-1252 under the name `latin1`, which
  also affected `pd.read_csv` of a CSV containing them.
- **`to_pandas()` failed unless the file also imported pandas.** The import
  is inside the method, so nothing in the file told the host to load the
  package.
- **`regular_polygon` drew a diamond for any even number of sides**, and
  reported the size of the circle it was cut from rather than the shape's:
  `regular_polygon(40, 4, ...)` was a 57x57 diamond instead of a 40x40
  square. Sizes are also no longer rounded up by a pixel when the
  trigonometry lands just over a whole number.
- **An error's column was reported too far right** - `print(y)` blamed
  column 11 of an 8-character line. The caret in a traceback is offset by
  the indent Python adds when it echoes the source, and Python strips the
  line's own indent first, so the column was wrong on every line and wrong
  by a different amount on indented ones.

## 0.1.2 (2026-09-23)

### Fixed
- **`pll-python` now pins the exact Pyodide the extension uses.** It asked
  for `^0.29.3`, so a fresh install could resolve a newer patch than the
  extension ships — and an Examplar bundle is bytecode, which has to match
  the interpreter that will run it. Nothing was broken in practice (0.29.3
  and 0.29.5 are both CPython 3.13.2, so their bytecode is interchangeable),
  but "matches by construction" is the whole reason bundles are built with
  this tool, and a range could not promise it.
- **The extension package no longer carries the command-line tool.**
  `dist-cli/` was being packed into the `.vsix`: about 420 kB the extension
  never loads, plus whatever tarball the last `npm pack` happened to leave
  behind.

### Changed
- **The README is reorganised.** Language levels and annotation checking now
  come before tests, so everything that talks about `#level` appears after
  the section that introduces it; `input()` sits beside the section on files
  next to your program. The Examplar section is shorter, shows the card
  rather than listing every message it can print, and no longer points at
  files in the repository — those are dead links from the extension page.

## 0.1.1 (2026-09-23)

### Added
- **Your tests can be checked against known implementations.** Put
  `#examplar <url>` in a file and every run adds a card per function, each
  answering two questions about your tests of that function. *Against
  correct implementations:* do they all pass? *Against buggy
  implementations:* how many do they catch? It works before you have written
  any code of your own, which is the point — write the tests first.

  Neither answer says more than it has to. A test that disagrees with a
  correct implementation is **named**, but you are not told what the right
  answer was; a buggy implementation that nothing caught gives up its id and
  nothing else. Say which thing is wrong, never what is right — otherwise
  the card is an oracle you can read the assignment off one
  deliberately-wrong test at a time.

  The second question waits for the first, and per function: no coverage
  number for a function until every test of it *passes*. A test that expects
  the wrong answer fails on the buggy versions too, and so does a test that
  cannot run, so either way it would look as though you had caught them. A
  function with no tests yet says just "No tests yet." rather than scoring
  you at something you have not started.
- **Examplar bundles can be authored.** `pll examplar build hw3/ -o hw3.json`
  compiles known-good ("wheat") and known-bad ("chaff") implementations into
  one bundle of Python bytecode, ready to publish at a URL. A chaff goes in
  `chaffs/<function>/`, named after the function it breaks, since the
  student's report is per function; its id is its filename and the one thing
  students ever see about one they missed, so number them rather than naming
  them after the bug. `--verify` runs your own suite against the bundle and
  refuses to write it unless that suite passes on every wheat and fails on
  every chaff.

  `samples/examplar_bundle/` is a worked example — two wheats, six chaffs
  and a staff suite — with `samples/examplar.py` as the student's side of
  it. Serving a bundle to the **web** build needs CORS:
  `Access-Control-Allow-Origin`, `Access-Control-Expose-Headers: ETag` (or
  nothing is ever cached) and `Access-Control-Allow-Headers: If-None-Match`
  (or students stay pinned to the copy they cached first).
  `samples/examplar_serve.mjs` is a dependency-free server that gets those
  right.
- **New `pll-python` npm package: the same language levels on the command
  line.** `npx pll-python hw.py` runs a file with the level from its own
  `#level` line, its in-file tests, and the same friendly errors as the
  editor — no Python installation, because it is the same Pyodide worker.
  Tables print as text; pictures print a note (or `--save-images`) and
  reactors do not animate, since a terminal cannot show either. Exit codes
  distinguish a level rejection from a failing test from a crash, so it can
  be used for marking.
- **Redefining a name the PLL libraries provide is now reported** at
  `#level beginner` and `#level intermediate`. `circle`, `rectangle`,
  `table`, `animate` and the rest are bound in every file before you write
  anything, so `def rectangle(w, h)` shadows one of them exactly as
  `list = [1]` shadows a built-in — and the message says which library the
  name came from. See `samples/beginner_library_shadowing.py`.

### Fixed
- **A shadowing finding now points at your own definition**, rather than at
  wherever the name happened to be bound first. Using a built-in or a
  library name without defining one of your own is not a finding at all.

## 0.1.0 (2026-09-16)

### Breaking
- **The level header is now `#level beginner`** (and `#level intermediate`,
  `#level advanced`) instead of `#beginner`. Write it in lower case on the
  first non-blank line. The old bare form is no longer recognised, so files
  using it fall back to the default.
- **New `#level raw`, and it is the default.** A file with no level header
  runs exactly as plain Python would - no static checks and no annotation
  checks - with PLL's built-in libraries and the interactions panel still
  available. Previously a file with no header was `advanced`, which checks
  annotations.
- **Removed the `pll.runtimeTypeChecking` setting.** Annotation checking is
  decided by the level alone: on everywhere except `#level raw`. One
  mechanism instead of two that could disagree.
- **PLL now needs VS Code 1.101 (June 2025) or newer.** That is the first
  release whose Node has a built-in WebSocket, which is what the universe
  client uses. Requiring it means one code path instead of a fallback that
  could only report that connecting was unavailable.

### Added
- **Animations and interactive programs.** `animate(draw)` and
  `reactor(...)` build an interactive program that runs as a card in the
  interactions panel, with `to_draw`, `on_tick`, `on_key`, `on_mouse` and
  `stop_when`. The card has play / pause, single-step, and a slider: every
  state is recorded, so you can rewind and play forward again. `big_bang`
  is the same as `reactor(...).interact()`. A reactor is a value, so
  `simulate_trace(n)` and `react(event)` let you test one without watching
  it run. See `samples/animation.py`.
- **Worlds can talk to a universe server.** A reactor with a `register`
  address connects to a WebSocket server; `package(state, message)` sends,
  `on_receive` receives, and the card shows the connection. You write
  worlds - the server is a separate program your course runs, and there is a
  dependency-free reference one in `samples/universe_server.mjs`. See
  `samples/universe.py`.
- **You can stop a running program.** A **Stop** button appears in the
  interactions panel while your program runs; Ctrl/Cmd+C (with nothing
  selected) and **PLL: Stop Program** do the same thing. The program ends
  with a `KeyboardInterrupt` and keeps whatever it printed first. Before
  this, a loop that never ended blocked every later run and only a window
  reload recovered. If a program cannot be stopped - stuck inside a library
  call, or catching `KeyboardInterrupt` itself - PLL now says so instead of
  appearing to do nothing.
- **More picture functions, following HtDP.** `overlay_xy` and
  `underlay_xy` place the second image at an offset (negative offsets grow
  the picture instead of cutting it off); `beside_align`, `above_align`,
  `overlay_align` and `underlay_align` choose which edges line up;
  `empty_scene` and `place_image` build a fixed-size scene and put an
  image's center at a point on it; `crop` takes a piece out of an image and
  `frame` outlines one. See `samples/scenes.py`.
- **New `pll.newFileLevel` setting.** When set, a newly created `.py` file
  starts with that `#level` line already in it, so a course can put students
  at the right level without them having to type it. Off by default, and only
  applies to files created empty. It is a template for new files: it does not
  change what a file *without* a level line means, which is always `raw`.

### Fixed
- Programs that print in a tight loop no longer make the interactions panel
  (and Stop) unresponsive. Live output is batched on its way out of Python
  and again on its way into the panel, a run no longer keeps a copy of output
  it has already streamed, and a single run renders at most 5000 lines before
  saying it stopped showing them. Stopping such a program now takes about a
  third of a second instead of upwards of fifteen.
- At `#level beginner` and `#level intermediate`, assigning to a name like
  `__import__` is now reported as shadowing a built-in. The check used to
  skip every name starting with `_`, which was meant to skip module
  metadata (`__name__`, `__doc__`) and skipped real built-ins too.

## 0.0.8
- **Type annotations are now checked while your program runs.** If a value
  does not match an annotation, the program stops where it happened with an
  explanation: arguments are reported at the call, return values at the
  `return`, and annotated variables on their own line. Every item of an
  annotated `list` / `dict` / `set` / `tuple` is checked, and a function
  that ends without returning anything is called out specifically.
  Functions without annotations are untouched, and a whole number is still
  accepted where a `float` is expected. Powered by typeguard, bundled into
  the extension, so there is nothing to install and it works offline. Set
  `pll.runtimeTypeChecking` to false to run your code as plain Python.
- At `#beginner` and `#intermediate`, `True` and `False` are no longer
  accepted where `int` or `float` is annotated. Python treats `True` as
  `1`, so this is a rule PLL adds; `#advanced` keeps Python's behaviour.

## 0.0.7
- Rewriting a file with the same contents still saves it and still
  shows the **Saved … next to this file** banner.
- If Python fails to start, the interactions panel now says so instead
  of showing an empty panel and a spinner that never stops.
- PLL no longer writes to your `settings.json` or `keybindings.json` on
  activation. Its editor defaults were already declared as
  `configurationDefaults`, which the runtime writes duplicated; the
  leftover keybinding cleanup could also clobber a `keybindings.json`
  that had comments in it.
- Friendly errors show the headline and **How to fix**; the unused
  "what happened" / "why it happens" paragraphs were dropped.
- **Correction to 0.0.6:** editor keyboard copy/paste on vscode-web
  works. 0.0.6 said it was unsupported and abandoned; that was wrong.
- Documented the one case where editor copy/paste really does fail in
  the browser: a non-QWERTY layout (Dvorak, Colemak, …), where VS Code
  web assumes QWERTY and reads Ctrl+C as another shortcut.
  `"keyboard.dispatch": "keyCode"` in **user** settings fixes it; PLL
  cannot ship the fix, as the setting is application-scoped.
- The desktop and web hosts now share one worker-protocol client
  (`common/workerRuntime.ts`) and one worker implementation
  (`common/workerHost.ts`) instead of two near-identical copies, and
  one shared `activate`. Removed the dead
  `pll.interactions.copy/cut/paste` commands and the host↔webview
  clipboard round-trip they needed (their keybindings went away in
  0.0.6). About 900 lines lighter.
- New smoke tests for the previously untested host-side logic:
  `scripts/smoke-repl-session.mjs` and
  `scripts/smoke-worker-protocol.mjs`.

## 0.0.6
- Editor **keyboard** copy/paste is **not** supported on vscode-web /
  `test-web` and is abandoned. vscode-web does not dispatch
  Ctrl/Cmd+C/V to commands (so the browser can copy without a
  prompt); binding those keys swallows them without running anything,
  and leaving them unbound still does not give working native copy in
  this setup. Use the editor **context menu** (right-click) or
  Command Palette **PLL: Editor Copy/Paste**. The interactions panel
  shortcuts from 0.0.5 are unchanged.
- The interactions pane shows a status in the empty stream while a
  run is preparing (Loading Python..., Loading libraries...,
  Running...) so a slow first import is not a blank wait.
- Files next to your Python script are visible to `open()`,
  `pd.read_csv("data.csv")`, and `to_csv` on **desktop and web**. After
  the run, new or changed data files (CSV, text, JSON, …) are saved
  back into that folder so you can open them in the editor. Python
  source files are not overwritten. A sibling `pandas.py` (as in
  `samples/`) no longer shadows the real pandas library.

## 0.0.5

- Copy, cut, and paste shortcuts work in the interactions panel on
  vscode.dev. The browser workbench was swallowing Ctrl/Cmd+C/V before
  the webview saw them; right-click paste already worked.
- PLL now declares support for untrusted and virtual workspaces, so it
  stays enabled in Restricted Mode and on vscode.dev instead of asking
  to be turned on for every folder.

## 0.0.4

- Third-party packages now load automatically. When a file or prompt
  imports a library that Pyodide ships (for example **pandas** or
  **numpy**), PLL loads it before running, showing **Loading
  libraries...** while it fetches. This makes data-analysis programs
  that use `import pandas as pd` run without any extra setup.
- Reading data from a URL now works on **desktop and web**. When your
  code imports a networked library (pandas, `urllib`, `requests`, ...),
  PLL applies the `pyodide-http` shim so calls like
  `pd.read_csv("https://.../data.csv")` reach the network. The browser
  still requires the source to allow cross-origin requests (CORS);
  desktop VS Code does not.
- `input()` now works on **desktop and web**. Prompts print in the
  interactions panel as the program runs, and you type the reply in the
  same input row. Desktop VS Code runs Pyodide in a worker thread so
  waiting for a line does not freeze the editor.

## 0.0.3

Add logo.


## 0.0.2

Documentation and command names for a closer-to-public extension release.

- Command titles now use a short **PLL:** prefix:
  **PLL: Run Python File**, **PLL: Show Interactions**,
  **PLL: Start REPL**, **PLL: Clear Interactions**.
- The interactions prompt now uses the language level of the last
  **PLL: Run Python File** (the level shown in the header), including
  static checks. Previously the prompt was always advanced.

## 0.0.1

Initial beta release.
