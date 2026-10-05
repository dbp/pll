# Changelog

## Unreleased

### Added
- **The command line runs the Examplar check.** A file with an `#examplar`
  line gets the same cards on `pll hw.py` as in the editor - the same lines,
  naming tests and buggy implementations by name and id only - before the
  program and its own tests. Bundles are cached on disk, so an offline run
  still gets its verdict, and the verdict does not change the exit code.

- **The command line takes options in the usual forms**: `--save-images=out`,
  `-qv`, and `--` before a file whose name starts with a dash. `examplar
  build` takes `--out` as well as `-o`.

### Changed
- **A file runs once, and its tests run after it.** The tests see what the
  program defined, and their card comes after what it printed. Before, the
  file was run once to find its tests and again as the program, so
  everything at the top of the file happened twice, the first time unseen:
  `input()` read a line meant for the program (on the command line) or
  failed so that the tests silently did not run (in the editor), and a file
  opened for appending got two lines. A program that raises, is stopped or
  calls `sys.exit()` now leaves its tests unrun, and PLL says so.
- **An error a test raised reads like any other error.** It goes through the
  same explanations as an error the program raises, so a `NameError` inside
  a test gets PLL's wording too, where before only a few kinds did. The test card and the command line show it the way a
  finding is shown everywhere else: its type, where it happened (in a helper
  the test called, say, rather than the test's own line), and what to do.
- **An error in a reactor's handler is explained** - `on_tick`, `to_draw`
  and the rest. It used to be shown as Python's raw traceback, through PLL's
  own frames.
- **A library's error is named by its class alone** (`ParserError`, not
  `pandas.errors.ParserError`), as the built-in ones always were.
- **The editor and the command line say the same things about a run**, in
  the same words, because they now run the same steps. "Static analysis
  found 2 problems. The file was not run." replaces both "Static analysis
  found issues. File not executed." and "... 2 problem(s). File not run.";
  a checker that fails says "Static analysis failed (...). Running anyway."
  in both; and a saved file is "Saved out.csv next to hello.py." rather than
  "next to this file".

- **The command line exits with the status a program ends itself with**,
  as `python` would: `sys.exit(3)` exits 3 (and `os._exit(5)` 5), where
  every program that ended itself used to exit 0. A status other than 0
  outranks a failed test's 3, which is still listed.
- **Closing a file ends its session**: its output in the panel, its
  reactors, and the names its runs defined, which were kept until the
  window closed - for every file opened in it. Opening the file again
  starts afresh. A run still going when the file closes finishes first.

### Fixed
- **Stop ends an Examplar check.** A Stop was recorded as the running test's
  error and the check carried on, so a test that looped needed one Stop for
  each known implementation - and the panel meanwhile suggested reloading
  the window.
- **What a reactor's handlers print is shown.** A `print` in `on_tick` or
  `to_draw` went to a log no student sees; it now appears in the panel like
  the program's own output.
- **PLL: Clear Interactions clears the session**, as the panel's Clear
  button does. It cleared only the panel: the output came back when the file
  was shown again, and a reactor kept ticking with no card.
- **A location opens the right file, at the right column.** Two `main.py`s in
  different folders opened whichever ran last, and the cursor landed one
  column to the left of the error.
- **The status after `input()` is answered** reads "Running..." again, rather
  than "Waiting for input..." whenever the file is shown.
- **A failed load is tried again.** A dropped connection while pytest or the
  network shim loaded - or a failed start of Python itself - lasted until the
  window was reloaded.
- **A Python that stops completely is replaced** by the next run, instead
  of every later run waiting forever (a worker that crashed) or failing
  until the window was reloaded (a fatal error inside Pyodide). Every file
  that had run says that what it defined is gone, not only the one that
  was running. A crashed worker is noticed on desktop and the command line;
  a fatal error, on the web too.
- **`os._exit()` and `os.abort()` end the program, not Python.** They ended
  the interpreter every file shares, so every later run, of any file,
  failed. They now end a program the way `sys.exit()` does.
- **A `None` is traced to where it came from.** `print(x.total)` with `x =
  deposit(...)` said "`print(...)` gave back `None`" - the first call on the
  line, and the one that only wrapped the value. It now says "`x` is
  `None`", that `x` was set from `deposit(...)` on line 4, which gave back
  `None` - or, for a parameter, which call passed it. The same for a `None`
  that is subscripted, looped over, or added to.
- **The fix offered for a discarded `add_column` fits where it is.** At
  `#level intermediate`, inside a function, it now offers `employees =
  employees.add_column(...)` - which that level accepts there - rather than
  a new name, which is only needed at module scope.
- **A tab in the indentation is pointed at**, at column 1, rather than at the
  first character after it.
- **A top-level error in a file with tests was reported twice in the
  editor** - once as the tests were looked for, once by the program. It is
  reported once, by the program, as the command line already did.
- **The command line wrote files back even when it had failed to load
  them** for the program. The editor never did, and now neither does.
- **`pll x.py --save-images --quiet` says the directory is missing**,
  rather than saving pictures to a directory called `--quiet`.
- **`sys.exit("message")` shows its message**, in the panel and on the
  command line, as Python prints it; it was dropped.
- **A `#level` line under code is reported**, as one under comments
  already was, instead of the file running as ordinary Python without a
  word. (0.3.0 said this was so; it was true only under comments.) A
  `#level` line inside a docstring is still just text.
- **The advice for an annotation `row` is `dict`**, the type of a row. It
  said `Row`, which is not a name a program has, so following it gave a
  NameError.
- **A reactor that floods the panel is pointed at Pause.** Its handlers
  print after its run is over, so the banner's "press Stop" had nothing to
  stop.
- **`pll -q` no longer prints Pyodide's "Loading ..." and "Loaded ..."
  lines** when a file has tests. The tests' result is still shown, and so is
  a package that fails to load.
- **A dict's key is quoted the way its value is** in a type message: `the
  value for key "a" is the string "1"`, not `key 'a'`.
- **The Examplar check is not run if your files cannot be set aside first.**
  The known implementations run without access to the student's files; if
  emptying the work directory failed, they ran with the files there.
- **A Python worker that crashes is reported once**, as Python having
  stopped, rather than also as an "Internal error" with the crash's own
  message (desktop and command line).
- **The web version's message when `input()` cannot work** is for
  students: it no longer tells them to run `pnpm run test-web`.
- **An empty `pll.pyodideIndexUrl` means the default** in the web version,
  rather than a Python that cannot start. The setting's description no
  longer asks for a trailing slash, which was never needed, and says it
  applies to the web version only.

## 0.3.0 (2026-10-02)

### Breaking
- **A `#level` line that does not name a level is now an error**, instead of
  silently running the file at `raw` with none of the checks the student
  asked for. `#level begginer`, `#level Beginner`, a bare `#level`, a
  missing space (`#levelbeginner`), and a valid line that is not the first
  line are each reported, with the level suggested where it is a
  misspelling. A file with **no** `#level` line is unchanged: it runs as
  ordinary Python.
- **New checks at `#level beginner` and `intermediate` can stop a file that
  used to run.** The mistakes listed under Added that used to run in
  silence are errors, except a method named but not called and a test
  nothing runs, which are warnings and let the file run. A file stopped by
  one was not doing what it looked like it was doing, but it did run.
- **More library calls refuse what they used to accept.** A colour *name*
  that is not one (`"bleu"`), the image arguments listed under Added, a
  function given to a table method that takes the wrong number of things or
  whose `filter` returns something other than `True` or `False`,
  `order_by(..., ascending="False")` and `select_columns("name")` each stop
  the file with a message, where before they drew nothing, did the wrong
  thing, or failed later somewhere less helpful.
- **The command line exits 1 when Ctrl+C stops it**, wherever the Stop
  lands - during the tests or before the program starts - rather than going
  on to run the program.

### Added
- **Mistakes that used to run in silence are now reported** at
  `#level beginner` and `#level intermediate`: a comparison used as a
  statement inside a function (a test written without `assert`, which
  always passes), any other value computed and thrown away, `assert(x, 1)`
  (a pair is never false), a function containing `assert` that nothing ever
  runs, a method named but not called (`movies["rating"].mean`), an
  annotation that names a function rather than a type (`t: table`), a
  dataclass field with no type or written `year = int`, a class with fields
  and no `@dataclass`, and `a == Boa`, which is always False.
- **A reactor that is built and never started** now says so at the end of
  the run, instead of doing nothing without a word.
- **Misspelled colours are refused with the name you meant.** Colour names
  are checked against the CSS colours - the names a browser understands -
  so `"bleu"` says "Did you mean `blue`?" rather than drawing nothing.
- **Every image function checks its arguments when it is called.**
  `beside(a, "austria")` names the argument and what it was; a size given
  as a string or a negative number, a `scale` factor of 0, and a list
  passed where the images themselves belong are each refused; `rotate(image,
  45)` says the angle comes first; and `a + b` on two images says to use
  `beside`, `above` or `overlay`. No message names an internal class.
- **Table and row errors say what to do.** A row of the wrong length shows
  the row and the columns; column names given as one string, rows not
  inside an outer list, and a duplicated name each say what the shape
  should be; a row explains itself (`this row has no column "rider" ...
  Did you mean "riders"?`) and says to use square brackets for a field;
  `row("Mar")` says it wants a row number; out of range says how the rows
  are numbered; and "no column named ..." suggests the closest one,
  noting when it differs only in case.
- **The functions passed to the table methods are checked.** A value passed
  where a function belongs, a function that takes the wrong number of
  things, and a `filter` function that returns something other than `True`
  or `False` are each refused, naming the method and the function.
  `order_by(..., ascending="False")` and `select_columns("name")` are no
  longer accepted silently.
- **`load_table` recognises a web page** instead of parsing HTML as CSV, and
  points at GitHub's Raw button; a missing file lists the CSV files that
  are there.
- **A column that a discarded `add_column` would have made** says so:
  "`add_column` makes a new table; it does not change `employees`". Only
  `add_column`, and only when the discarded call is on some other line - a
  misspelled column stays a misspelled column. At `#level beginner` and
  `intermediate`, which refuse `employees = employees.add_column(...)`, the
  fix offered is a new name instead.
- **A table-row error points at the row**, not at the `table(` line: for a
  table written one row per line, the third row's mistake is reported on
  the third row's line.

### Changed
- **A static finding that is only a warning no longer stops the file from
  running.** The findings that existed before are all errors, so nothing
  changes for them; the new ones that are about code that still works - a
  method named but not called, a test nothing runs - are shown and the
  program goes ahead.
- **Python's own messages are reworded**, with the shape of the student's
  own code filled in: `pen_cost() missing 1 required positional argument`
  becomes "`pen_cost` takes 2 arguments (`num_pens` and `message`), but got
  1"; `ITunesSong.__init__()` no longer mentions an `__init__` nobody
  wrote; `'types.UnionType' object is not callable` names the union and its
  members; `'int' object is not iterable` recognises `for x in len(xs)`;
  `3(width)` says to write the `*`; and `'ITunesSong' object has no
  attribute 'yaer'` lists the fields and suggests `year`. Messages no rule
  recognises are still shown as Python wrote them.
- **"Finished without returning a value" is now three different messages.**
  Running off the end, a `return` that returned `None` (naming the
  `.append(...)` the value came from), and a `match` where no `case` fitted
  are told apart; a missing union variant and a `[f, r]` that should be
  `[f, *r]` are named outright. A function that prints instead of returning
  is asked whether `return` was meant.
- **Advice that pointed the wrong way has been redirected.** Two functions
  with the same name no longer get the advice for a reassigned variable;
  `global` at `#level intermediate` no longer also reports shadowing, and
  both level findings now name the level that would allow what was written;
  a dataclass field mismatch is phrased as a field rather than an
  assignment; a value a library handed over - including a reactor's state,
  traced back to `init` - says so instead of asking about "the value you
  passed on this line"; the advice to convert a column with `float` is only
  given when the column actually holds numbers; a `match` with no fitting
  case no longer suggests annotating the return type as `None`, which would
  hide the bug; an annotation like `string` is said to fail, since it
  does, rather than to be accepted and check nothing; a function returning
  `None` because one branch ends in `print` is asked "did you mean `return
  order_amt + 4`?", with that branch's own expression; and a class passed
  where one of its values was wanted is "the class itself, not one made
  from it".
- **A `NameError` gets the hint that fits.** A name an import provides gives
  the import line (`pd` used to be answered with Python's suggestion of
  `id`); a name defined further down says which line it is on, rather than
  asking about the spelling; a forward reference in an *annotation* is told
  to write the string form (`rest: "NumList"`), which is the only way a
  type that names itself can be written, rather than to move a definition
  that cannot move; and `filter(below_1k(r))` explains that `filter` calls
  the function for you.
- **Errors raised inside a test are translated too.** Only a type-annotation
  failure used to be; `can only concatenate list (not "str") to list` and
  `test_pen_cost() missing 1 required positional argument` reached the test
  report in Python's words, beside a run that had better ones.
- **Advice quotes the program, not a fixed example.** The comparison hint
  names the conversion for the types actually compared and mentions CSV
  columns only in a file that reads one; `"Total: " + add_shipping(...)`
  is answered with `str(add_shipping(...))` - the whole call, not the
  function - and `print("Total:", ...)`, without the space `print` adds
  itself; `age + 1` where `age` came from `input` is answered with
  `int(age) + 1`; `song["year"]` with `song.year`; `3(4)` with `3 * 4`;
  `to_draw=draw_dog(0)` with `to_draw=draw_dog`; and `name = str` in a
  dataclass with `name: str` - it used to say `name = int` whatever type
  was written.
- **`filter("riders" < 1000)` is named as the mistake it is**: a condition
  given where a function belongs. The comparison is worked out before
  `filter` runs, so Python's error is about comparing text with a number;
  the finding says so, and shows the condition inside a function, with
  `r["riders"]` for the column.
- **An element that fails its annotation is shown**: "every item in `lst`
  should be a number, but item 0 is the string "1"", rather than "item 0
  is not". Python reads the value from the frame the check fired in.
- **Assigning to a parameter where its field was meant** -
  `ac = ac.balance + amt` - is answered with `ac.balance = ac.balance +
  amt`, rather than "Assign `Account` to `ac`".
- **`int` on typed text says where the text came from.** A word typed at
  `input()` is explained as what was typed; the bullet about CSV cells
  appears only in a program that reads one.
- **What Python can see is now said.** An index error gives the list's
  real length ("`nums` has 3 items, numbered 0 to 2") rather than a
  made-up list of 3; two dataclass values given in each other's places
  are named as swapped, where converting one would have hidden it; a
  value thrown away suggests `return order_amt + 8` or `ac.balance =
  ac.balance + amt` from the line itself; and a test written without
  `assert` suggests `assert pen_cost(0, "huskies") == 1`, not
  `assert ...`.
- **Suggestions read as suggestions.** One candidate is "Did you mean
  `width`?", not "try one of those", and a name that differs only in case
  says so; a column name that starts another (`hours`, `hours-worked`) is
  suggested; a missing file names the near miss, rather than listing every
  CSV beside it; and file names are quoted the way the course writes them.
- **A table row is a `dict`**, as the course says, in every message - a
  type error no longer reports "got `Row`" or suggests annotating `Row`.
- **Two floats that differ only in their last digits** suggest
  `pytest.approx` instead of leaving `0.9299999999999999 == 0.93` to be
  puzzled over.
- **A stopped program says "The program was stopped."** It read
  "KeyboardInterrupt while running your program", which sounds like
  something the program did wrong rather than something the student asked
  for.

### Fixed
- **Every runtime error is now reported as a finding**, at the student's own
  line, instead of as a traceback through PLL's internals (and, for pandas,
  through pandas'). The useful message was usually the last line of that
  traceback; now it is the first thing shown.
- **Syntax errors are findings too**, with better wording where Python's is
  misleading: `else if` says to write `elif`, `if x = 5` suggests `==` only
  (never the walrus), `class = 30` says `class` is reserved, a curly quote
  says where curly quotes come from, and a mixed tab names VS Code's
  "Convert Indentation to Spaces". Messages that were already clear are
  left as Python wrote them.
- **An error in a file with tests was reported twice** — once as the test
  phase loaded the file, once by the run.
- **Class names in type messages no longer carry PLL's internal module**
  (`__pll_test__.Account` is now `Account`).
- **The CLI printed package-loading progress on stdout**, which is reserved
  for the program's own output, so `pll hw.py > out.txt` captured it.
- **A name used before it had a value was not named.** Python words that one
  as `cannot access free variable 'title' ...`, which PLL did not recognise,
  so the report read "Python doesn't know what `this name` means" — in a file
  where `title` is right there. It now names the variable, and says to move
  the line that sets it rather than to check a spelling that was already
  correct. `UnboundLocalError` is explained too, where before it fell
  through to a bare traceback.
- **A `SyntaxWarning` is said once, and never beside its own finding.** Each
  phase compiles the file more than once, and Python printed the warning on
  every compile - four copies for a missing comma between rows in a file
  with tests. Now a warning the run's error explains is dropped, and one
  about a line that never ran is said once, in PLL's words: Python's
  "perhaps you missed a comma?" for `3(4)` becomes "write the `*`: `3 * 4`".
- **Stop sometimes did nothing.** Pyodide checks for a Stop by reading the
  signal and then clearing it, as two separate steps, so a Stop that arrived
  between them was erased and the program ran on - about one press in twenty
  to forty in a freshly started program, more under load. A Stop is now
  re-asserted until Python acknowledges it, and a repeat of one already
  delivered is consumed rather than raised a second time into PLL's own
  clean-up. A program that catches the first `KeyboardInterrupt` can still
  be stopped by the next press. This was also the intermittent
  `smoke-interrupt` failure, which now has deterministic tests for each part.
- **Play did nothing after going back from where `stop_when` stopped.**
  The card remembered that the reactor had stopped, rather than whether the
  frame on screen was the stopped one, so Play stayed enabled and did
  nothing while the step buttons still worked. Play now runs on from the
  earlier frame, to the end again.
- **The animation slider looked stuck while playing.** It shows the recorded
  history, and a running animation is always at its newest frame, so it was
  always full. The counter now says `frame 116 · live` there, the way a live
  stream's player does; going back shows `frame 40 of 116` as before.
- **The one-frame-back button looked like "play backwards".** It is now the
  mirror of the one-frame-forward button, bar included.
- **A Stop during the tests did not stop the run.** It ended the test that
  was running, recorded that as the test's error, and carried on: the other
  tests ran, and then the program - which, if it looped as well, needed a
  second Stop (and in the command line a second Ctrl+C, which kills `pll`
  instead of stopping it). A Stop now ends the whole run, wherever it lands.
  The tests that finished keep their results, the one that was running is
  marked as stopped, nothing after it runs, and PLL says what was not run.
  The command line exits 1.
- **A Stop pressed while something loaded was lost.** With no Python
  running to take it - Python, libraries, files, pytest or a bundle still
  loading - the program ran anyway. The run now checks between its steps
  and ends at the next one, before anything else starts.
- **A Stop could come back as an error.** One pressed just as a run began
  landed while PLL was still preparing the file, and was shown as "Internal
  error: KeyboardInterrupt"; one that nothing took was raised in the next
  run's static checks instead, as "Static analysis failed". Both are now
  the Stop they were, and a step that fails because of a Stop (loading
  pytest, say) no longer reports that as a failure of its own.
- **`case Boa:` crashed the command line.** Code that parses but does not
  compile escaped the test phase entirely: exit 64, a doubled traceback,
  and the file never ran. It is now reported like any other syntax error,
  at the `case` line, with the missing brackets explained.

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
