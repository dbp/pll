# PLL architecture and development

This document is for people working on Python Language Levels, not for
students using the extension. For how to *use* PLL, see [README.md](README.md).

PLL runs Python with [Pyodide](https://pyodide.org) inside VS Code. The
same interactions UI works in **desktop VS Code** (Node host) and
**vscode.dev** (web extension host), and the same checks run on the command
line via the `pll-python` npm package (a third host; see
[Command line](#command-line-pll-python)).

## Layout

Both hosts share everything except how they spawn a worker and where
Pyodide's assets come from. `common/workerRuntime.ts` and
`common/workerHost.ts` hold the two ends of the worker protocol; the
`desktop/` and `web/` files below them are thin adapters.

```
src/
├── desktop/extension.ts           Desktop entrypoint (Node host)
├── web/extension.ts               Web entrypoint (vscode.dev)
├── web/pyodideWorker.ts           Browser Worker: boots Pyodide via importScripts
├── web/pyodideRuntime.ts          Spawns the browser Worker
├── desktop/pyodideWorker.ts       Node worker_threads Worker: boots Pyodide
├── desktop/pyodideRuntime.ts      Spawns the Node worker; finds vendor/pyodide
├── desktop/xhrPolyfill.ts         Sync XMLHttpRequest for pyodide-http
├── desktop/syncHttp.ts            Child-process fetch used by the XHR polyfill
├── cli/bin.ts                     `pll` entry point: exit codes
├── cli/main.ts                    Argument parsing, SIGINT -> interrupt
├── cli/run.ts                     One file, in the editor's order
├── cli/view.ts                    ExecutionEvents as text
├── cli/files.ts                   Sibling files over node:fs
├── cli/stdin.ts                   Line reader for input()
├── cli/runtime.ts                 The Node host, pointed at this package
├── cli/examplar.ts                `pll examplar build --verify`
├── cli/bundleStore.ts             On-disk bundle cache
└── common/
    ├── activate.ts                Shared activation for both hosts
    ├── workerProtocol.ts          Shared worker message types
    ├── workerRuntime.ts           Host side of the protocol: request/reply
    │                              correlation, live displays, stdin
    ├── workerHost.ts              Worker side of the protocol: one Pyodide
    │                              interpreter + the message dispatch
    ├── stdinBuffer.ts             SharedArrayBuffer protocol for input()
    ├── interruptBuffer.ts         SharedArrayBuffer protocol for Stop
    ├── workspaceFilePolicy.ts     Which sibling files to mount / write back
    ├── workspaceFiles.ts          vscode.workspace.fs snapshot + writeback
    ├── memfsWorkspace.ts          Pyodide MEMFS mount / collect helpers
    ├── commands.ts                Run File / Show Interactions / Clear / Stop
    ├── editorClipboard.ts         Palette PLL: Editor Copy/Cut/Paste (no keys)
    ├── runPlan.ts                 The steps of a run, for every host
    ├── replSession.ts             Drives the interactions view: init,
    │                              REPL multi-line buffer, exec chain, and the
    │                              panel's side of a run plan
    ├── reactorController.ts       Reactors' clocks, card controls, universe sockets
    ├── interactionsView.ts        WebviewView provider for the integrated
    │                              text + image stream + input row
    ├── newFileLevel.ts            Seeds new .py files with a #level line
    ├── level.ts                   `#level raw|beginner|intermediate|advanced`
    │                              header parser; the single source of what
    │                              each level checks
    ├── errorFormatter.ts          Plain-text rendering for diagnostic tooltips
    ├── diagnostics.ts             VS Code DiagnosticCollection (multi-finding)
    ├── pythonSources.ts           The Python run in Pyodide, inlined as strings
    ├── packages.ts                Which packages a program needs, from its text
    ├── wire.ts                    The shapes of what the Python side returns
    ├── pythonVendor.ts            Bundled typeguard / typing_extensions wheels
    ├── deliverResult.ts           Translates Python results to ExecutionEvents
    ├── bootstrap/                 Real Python, one file per concern, loaded in order:
    │   ├── typeChecking.py        the level's checks; typeguard set up
    │   ├── errorInfo.py           an exception described for the host
    │   ├── sessions.py            per-file globals; output in program order
    │   ├── stop.py                Stop as KeyboardInterrupt, acknowledged
    │   ├── compile.py             AST passes over the student's code
    │   ├── libraryHelpers.py      what the libraries share (sources, names)
    │   ├── running.py             run a file / a prompt line
    │   ├── tests.py               the file's own tests
    │   └── staticAnalysis.py      the checks made before a program runs
    ├── imageLib.py                Real Python: SVG image primitives + combinators
    ├── reactorLib.py              Real Python: reactor values + history
    ├── examplarLib.py             Real Python: wheat/chaff build + run
    ├── universeClient.ts          World-side protocol, transport, failure text
    ├── examplarSource.ts          #examplar directive, fetch + cache
    ├── vscodeBundleStore.ts       Bundle cache in globalState (web included)
    ├── tableLib.py                Real Python: Table type + charts
    ├── analyzers/
    │   ├── runtimeFinding.ts      Error event -> finding (both hosts)
    │   ├── types.ts               AnalysisFinding, RuntimeAnalyzer
    │   ├── nameErrorAnalyzer.ts   Runtime: NameError -> friendly finding
    │   ├── typeCheckAnalyzer.ts   Runtime: TypeCheckError -> friendly finding
    │   ├── registry.ts            Runtime analyzer registry
    │   └── static/
    │       ├── shadowingExplainer.ts            shadowing + shadowing-builtin
    │       ├── reassignmentExplainer.ts         reassignment
    │       ├── disallowedKeywordExplainer.ts    `global` / `nonlocal`
    │       └── registry.ts        Wraps Python-side raw findings
    └── errors/
        ├── pythonError.ts         An exception as Python describes it: frames, facts
        ├── libraryFacts.ts        What the explanations know about PLL's library
        ├── sourceFacts.ts         What they read from the student's file
        ├── nameErrorExplainer.ts
        ├── syntaxExplainer.ts
        ├── stockMessageExplainer.ts  Python's wording -> beginner wording
        └── typeCheckExplainer.ts  typeguard wording -> beginner wording

vendor/
└── python/                        Pure-Python wheels, inlined by esbuild
    ├── typeguard-*.whl
    └── typing_extensions-*.whl

media/
├── interactionsView/
│   ├── style.css                  Stream + input row styling
│   └── main.js                    View-side state, history, message routing
├── pll-icon.svg                   Panel container icon
└── error-gutter.svg               Diagnostic gutter icon
```

The static analyzer (scope builder, shadowing/reassignment checks) lives
in `bootstrap/staticAnalysis.py`. esbuild's `text` loader inlines the
Python files as strings at build time, and they are loaded into Pyodide
once on init. Analysis therefore runs in the same Python interpreter that runs the user's code,
in both desktop and web hosts.

Prompt submissions use the language level of the last Run File
(`session.lastLevel`, shown in the interactions header), or `raw`
if the file has not been run. At beginner/intermediate, the snippet is
analyzed with `sessionKey` so names already bound in the session count
as preexisting module bindings. Those findings stay in the interactions
view; they are not mapped onto the `.py` file.

File tests do **not** call `pytest.main()` (unsafe to invoke repeatedly
in one Pyodide interpreter). PLL loads the pytest package when a file
looks like it contains tests, rewrites asserts, collects `test_*` /
`Test*` in the file, and calls each test function. Users can still
`import pytest` (for example `pytest.approx`) because the package is
loaded into that interpreter.

## Language levels

Four levels, parsed from a `#level <name>` comment on the first non-blank
line by `level.ts`. The syntax is exact: lower case, one space, one of the
four names. Anything else - including the old bare `#beginner` form - is not
a header and falls back to the default.

| level | static checks | annotations checked | `bool` where a number is annotated |
| --- | --- | --- | --- |
| `raw` (default) | no | no | n/a |
| `beginner` | all | yes | rejected |
| `intermediate` | all, but reassignment only at module scope | yes | rejected |
| `advanced` | no | yes | allowed, as in Python |

`raw` is the default so that a `.py` file written without PLL in mind
behaves exactly as CPython would; every difference has to be opted into by
naming a level. It is also the answer to "how do I turn the checks off",
which is why no setting does that.

Python enforces these rules and the host explains them, so each has two
homes, and they are kept to exactly two. On the host, the predicates in
`level.ts` are the only place a level is asked about -
`levelHasStaticChecks`, `levelRejectsBoolAsNumber`,
`levelRefusesReassignment` - and the explanations use them to word a finding
and to offer only fixes the level accepts. In Python, `_pll_apply_level`
decides whether annotations are checked and how strictly, and
`_pll_static_analyze` which reassignments it refuses. Adding a level means
adding it to `Level`, `LEVEL_NAMES`, those predicates, and their Python
counterparts.

### Seeding new files

`pll.newFileLevel` puts a `#level` line at the top of a newly created `.py`
file (`newFileLevel.ts`, on `workspace.onDidCreateFiles`). Default `none`,
so PLL writes nothing unless a course asks for it; the intended deployment
is the handout's `.vscode/settings.json`.

This is a **template**, not a second source of truth, and the distinction is
the whole reason it is allowed to be a setting at all. The level still ends
up in the file, on the first line, where the student can see and change it -
so the same file behaves the same way everywhere. A setting that changed
what a *headerless* file means would be the opposite: two students running
identical code would get different answers depending on configuration
nobody can see from the code. `DEFAULT_LEVEL` stays hardcoded to `raw` for
that reason.

Only files that arrive empty (or whitespace-only) are seeded. A `.py` with
content was copied, generated, or restored, and prepending to it would be an
edit nobody asked for.

## Images

`imageLib.py` follows HtDP's `2htdp/image`. The protocol is small: an
`Image` has `width` and `height`, and `_render_body(x, y)` returns an SVG
fragment drawn with its top-left at `(x, y)`. `to_svg()` renders the root
from `(0, 0)` into `viewBox="0 0 w h"`, so **nothing may draw at a negative
coordinate**.

That matters for `overlay_xy` / `underlay_xy`, where a negative offset moves
the second image left or up and the bounding box has to grow that way -
shifting the composite's own origin, which the protocol has no way to
express. `_LayeredXY` absorbs it locally: it reports the union size and
shifts *both* children right / down by however far the box grew, so its
parent still sees a plain top-left-at-`(x, y)` image. No other class needed
changing, and adding `place_image` on top of it was then trivial.

`crop` and `place_image` clip with an SVG `clipPath`, whose id comes from a
module counter (`_pll_next_clip_id`) - two crops in one picture must not
share one. Because the `<defs>` sits immediately inside the same group as
the `clip-path` reference, the rect is in the same user space even when an
enclosing `rotate` or `scale` has applied a transform.

`beside`, `above`, `overlay` and `underlay` are the centered special cases
of the `*_align` forms; `_pll_offset` is the single place that turns a place
name into a coordinate. The refactor that introduced it was checked by
rendering twelve pre-existing compositions before and after and diffing the
SVG - byte-identical.

Adding a combinator means three edits: the `_Foo(Image)` class, the public
wrapper, and the name in `PLL_IMAGE_EXPORTS` (that list is what injects it
into student globals with no import, via `PYODIDE_INSTALL_PY`).

## Third-party packages

Before running a file or a prompt line that contains an `import`,
`replSession` calls `runtime.ensurePackages(code)`, which delegates to
Pyodide's `loadPackagesFromImports`. That scans the code for imports,
maps them to packages in `pyodide-lock.json`, and loads the ones it
recognizes (with their dependencies) — so `import pandas as pd` pulls in
pandas, numpy, etc. Unknown imports (e.g. the user's own modules) are
ignored and surface as normal `ImportError`s at run time. Wheels come
from `indexURL`, falling back to the pinned jsdelivr CDN when they are
not vendored locally, so the first load of a package needs the network.
The call is gated on the code actually containing an `import`, so plain
REPL lines never pay a round-trip.

Pyodide's Node loader **writes wheels it downloads back into `indexURL`**,
which for the desktop host is `vendor/pyodide`. So running a pandas lab
locally leaves `numpy-*.whl`, `pandas-*.whl` and friends sitting next to
the four assets `copyPyodideAssets` put there. That is a cache, not build
output: `.vscodeignore` drops `vendor/pyodide/*.whl` so the `.vsix`
contains exactly what the build declares (5.8 MB) instead of whatever this
machine happened to download (13.6 MB, before the exclusion). If PLL ever
*should* ship a package, add it to `PYODIDE_ASSETS` so the build copies it
deliberately - do not rely on the cache being warm.

Pyodide does not connect Python's `urllib` to the host network, so
`pd.read_csv(url)` / `requests` / `urllib` otherwise fail with "unknown
url type: https". When the code imports a networked module
(`NETWORK_IMPORT_RE` — pandas, requests, urllib, ...), `ensurePackages`
also loads `pyodide-http` and runs `pyodide_http.patch_all()` once per
interpreter, routing those reads through the host's network. The web
worker uses the browser's synchronous XHR. The desktop worker installs
a Node `XMLHttpRequest` polyfill that performs the request in a child
process (`syncHttp.ts`) so the same `pyodide-http` patch works. Both
the load and the patch are guarded so non-networked programs never
load the shim. Browser requests still need CORS; desktop Node fetch
does not.

## From an exception to a finding

Python describes an exception as data; the host only explains it. Every
place that reports one - a file run, a prompt line, the test phase loading
the file, a single test, a reactor handler - goes through
`_pll_error_info`, which sends:

- the type, and the message **as Python's traceback shows it** (so a
  `NameError` keeps "Did you mean: 'total'?", which `str(exc)` lacks, and a
  `SyntaxError` loses the "(file, line)" its `str` carries);
- where it is: the innermost frame, or a syntax error's own position, with
  a column only where Python would draw a caret;
- the frames, outermost first (the innermost 100), each marked `user` or
  not. Which frames are the student's is decided here, once;
- facts learned from the live frames: the name a `NameError` is about, a
  sequence's real length, the element that failed its annotation, a
  swapped dataclass field. They travel beside the message, never in it.

`pythonErrorFrom` turns that into a `PythonError`, and is the one place a
Python `None` (which arrives as `undefined`) becomes `null`. The analyzers
read its fields; nothing on the host parses a traceback. `traceback` is
kept only to show when nothing better can be said.

There is then one way to explain an error: `findRuntimeFinding`, which
tries the analyzers in order and falls back to `analyzeRuntimeError`, so it
never returns null. Run errors reach it through `findingForErrorEvent`;
errors a test raised through `explainTestReport`, which puts the finding on
the test row; a reactor handler's error directly. Both hosts call these -
the runtime layer only translates results into events - and a test row's
finding is rendered by the same code as any other finding, in the panel and
on the command line.

## Runtime type checking

Annotations are checked while the program runs at every level except
`#level raw`, which exists precisely so a file can opt out. There is
deliberately **no setting** for this: the level is the only input, so
nothing can contradict it, and the `typeCheck` flag that used to ride
alongside `level` through the worker protocol is gone —
`_pll_apply_level` derives `_PLL_TYPE_CHECK` from the level instead. The
work is done by
[typeguard](https://typeguard.readthedocs.io), which is **not** in
Pyodide's lockfile, so `vendor/python/` holds its wheel plus
`typing_extensions` (its only dependency). esbuild's `base64` loader
inlines both into the bundle; the worker writes them into MEMFS under
`/pll_vendor` and appends them to `sys.path`, where zipimport reads them
in place — a wheel is a zip with the package at its root, so nothing is
unpacked and no network or `micropip` step is involved.
`typing_extensions` is pinned to the version in Pyodide's own lockfile,
and the paths are *appended*, so a program that later pulls in Pyodide's
copy (pandas depends on it) gets the same code either way.

Checking happens by AST instrumentation, not a decorator: typeguard's
`TypeguardTransformer` rewrites the tree before `compile`, alongside PLL's
existing transformers. So the check runs at the point of the violation — a
bad argument raises on entry to the callee, a bad return raises at that
`return`. Unannotated functions are not touched at all.

At `#level beginner` and `#level intermediate`, a `bool` is rejected where `int` or
`float` is annotated. Python makes `bool` a subclass of `int`, and both
mypy and typeguard follow it, so `count: int = True` is normally accepted;
at the teaching levels that is a hole worth closing, since a student who
annotates `int` and passes `True` has almost always made a mistake. It is
implemented as a `checker_lookup_functions` entry (typeguard's public hook)
that replaces the `int` and `float` checkers, gated on a module flag that
`_pll_apply_level` sets per run from the level the host passes in — so
`#level advanced` keeps Python's own rule, and the lookup is consulted on every
check rather than registered and unregistered. The replacements raise
typeguard's exact wording, so the host-side explainer needs no special
case; it only adds a note saying this is PLL's rule and not Python's.

Two adjustments to typeguard's defaults:

- `collection_check_strategy` is `ALL_ITEMS`. The default checks only the
  first item, so `[1, 2, "three"]` silently satisfies `list[int]`, which
  is indefensible when the annotation says otherwise.
- typeguard does not instrument annotated assignments outside functions,
  so `_PllTopLevelAnnAssign` wraps module-level `x: int = ...` in
  typeguard's own `check_variable_assignment`, keeping the wording
  identical to the in-function case.

Instrumentation is attempted on a second parse and validated by compiling
it, so anything typeguard cannot handle falls back to the plain tree. If
the wheels fail to load, `_pll_enable_type_checking` returns False and
instrumentation becomes a no-op: the program still runs, just unchecked.
That degradation is deliberate — this must never be the reason a
student's code will not run.

### Error messages

typeguard's wording is accurate but not teachable ("is not an instance
of", "did not match any element in the union"), so `TypeCheckError` goes
through the normal analyzer path and comes out as a finding labelled
`TypeMismatch`:

| typeguard | PLL |
| --- | --- |
| `argument "y" (str) is not an instance of int` | `add` expects `y` to be a whole number (`int`), but got a string (`str`). |
| `the return value (None) is not an instance of str` | `grade` should return a string (`str`), but it finished without returning a value. |
| `item 2 of argument "nums" (list) is not an instance of int` | `total` expects every item in `nums` to be a whole number (`int`), but item 2 is not. |

Two details that decide where the squiggle lands:

- An argument is checked on entry to the callee, so the innermost frame is
  the `def` line. `typeCheckAnalyzer` blames the frame *outside* it — the
  call — which is where the mistake actually is. Returns and assignments
  are blamed on their own line.
- `_pll_format_exception` drops frames inside `/pll_vendor`, so students
  never see typeguard's internals. When nothing is dropped it returns the
  stdlib formatting unchanged, so ordinary errors are unaffected.
- typeguard's union failures span several lines, and the lines after the
  first name the accepted types. The message reaches `typeCheckAnalyzer`
  whole.

## Reactors (big-bang / animate) and the universe client

`reactorLib.py` holds the model, which follows Pyret's reactors rather than
Racket's `big-bang`: a reactor is a **value**, and `react` returns a new one
instead of mutating. That choice is what makes the card's slider work -
rewinding is just holding an earlier value - and it is also what lets
`simulate_trace` test a reactor's logic with no clock and no drawing.

**Nothing in Python runs an event loop.** The extension host owns the clock
(`setInterval` in `ReactorController`) and calls `_pll_reactor_step` once per
event. A loop in the worker would hold it, and the exec chain with it, for
as long as the animation ran - the exact failure `Stop` exists for. Because
the host drives it, the prompt stays usable while something is animating,
and several reactors can run at once.

Frame budget is not a concern: a 60-sprite frame renders and serializes in
about 0.3ms under CPython, so even at Pyodide's 2-5x penalty there is two
orders of magnitude of headroom at 28fps.

Two details in the driver:

- Frames are **dropped, not queued**, while a step is in flight
  (`driver.inFlight`). A slow `to_draw` should make the animation choppy,
  not build a backlog that outlives the program.
- History is a list of `(reactor, event)` pairs with a cursor, not a list of
  states. Rewinding and playing forward again is therefore *replay* - the
  same values, not a recomputation that could drift if a handler is not
  deterministic. A new event at a rewound cursor discards the frames after
  it, like an editor's undo history.

A top-level `big_bang(...)` would otherwise print the returned reactor's
repr underneath its own card, so `interact()` marks the value it returns and
`_pll_show_top_level` skips anything carrying `_pll_already_displayed`. A
reactor that was *not* started still displays, as the picture for its
current state, via the usual `_pll_image_data` duck-typing.

### Universe: the client only

Racket's `universe` is a TCP server plus clients, and a browser worker
cannot listen for connections - so a faithful port is impossible. What is
possible, and what students actually need, is the **world** half: they write
worlds, never servers. So PLL only dials out, and the server is an ordinary
process the course runs in any language.

The protocol is deliberately ours and deliberately tiny: one JSON value per
WebSocket text message, each way, with no envelope and no handshake. A
conforming server is a page of code - see `samples/universe_server.mjs`,
which is dependency-free so it can be copied anywhere.

The socket lives on the **extension host**, next to the clock, so a received
message is just another event for the same reactor driver and the Pyodide
worker needs no networking at all. Outgoing messages come from
`package(state, message)`; they are held (up to `MAX_UNIVERSE_BACKLOG`) if
the socket has not opened yet, and flushed on open.

There is **one** transport, in `universeClient.ts`, and it is worth saying
why there is no per-host adapter here when everything else has one.
`WebSocket` is a global in browser workers, and in Node from v22 - which
`engines.vscode: ^1.101.0` guarantees (see below). Node's is undici's and
fully spec-shaped: an `EventTarget` with `onopen` / `onmessage` / `onclose`
/ `onerror`, close events carrying `.code`. So there is nothing to branch
on. An earlier version feature-detected the global and fell back to an
optional `ws` package; raising the engine floor deleted both files, the
detection, the dependency and its esbuild `external` entry.

Neither platform reports *why* a connection failed - browsers hide it on
purpose, and Node raises an `ErrorEvent` whose `message` is empty - so
`UNIVERSE_CONNECT_HELP` supplies the text. An empty reason in the panel is
worse than a guess.

## Workspace files (`open` / `to_csv`)

Pyodide's disk is an in-memory MEMFS. Workspace files are not there
unless PLL copies them in. Both hosts already have
`vscode.workspace.fs` (including github.dev virtual repos), so PLL does
not mount Node `fs` or a browser File System Access tree.

Before a file run (after static checks, before tests) and before each
REPL evaluation, `replSession` lists **regular files in the same folder**
as the script, prefers unsaved editor buffers, and sends text files
(`.csv`, `.txt`, `.tsv`, `.json`, `.md`, `.dat`, `.xml`, `.py`) to the
worker. The worker writes them into `/home/pyodide/pll_workspace` and
`chdir`s there so `open("library_loans.csv")` and
`pd.read_csv("library_loans.csv")` work. Names with `/`, `..`, or a
leading dot are rejected. Size caps: 2 MiB per file, 8 MiB total, 50
files. Untitled editors have no folder; the work dir is still cleared
so a previous run's files do not leak across.

After the run (or REPL line), the worker reports data files that are
new or were written (mtime changed, even if the bytes match — so two
functions that write the same CSV both count). PLL writes those back
with `workspace.fs.writeFile` so students can open `home_loans.csv` in
the explorer. `.py` files are mounted for `open` and for sibling imports
whose names are not already installed (a local `helper.py` still
imports; a local `pandas.py` must not win over the real package). They
are **not** written back. A short interactions banner lists what was
saved. The work dir is cwd, so PLL drops `''` from `sys.path` and
appends the work dir after site-packages.

This is a snapshot around the run, not a live VFS: inspect output after
the program finishes. Binary files and subdirectories are ignored.

## Interactive `input()`

`input()` is synchronous Python, but the interactions view is
asynchronous. Both hosts run Pyodide in a worker and bridge that with
two pieces:

1. **Live output.** `_pll_push` in `bootstrap/sessions.py` optionally
   calls `_pll_live_emit` (a JS callback) on every stdout/stderr write
   and every image/table. The worker posts a `display` message so the
   prompt of `input("Choice: ")` appears *before* the program blocks.
2. **Blocking stdin.** Pyodide's `setStdin({ stdin, autoEOF: true })`
   calls the JS `stdin` callback once per `input()`. That callback
   cannot `await` a UI event (it is synchronous), so the worker
   `Atomics.wait`s on a `SharedArrayBuffer` while the extension host
   shows the input row. The host writes the line into the SAB and
   `Atomics.notify`s. `autoEOF: true` is required: without it, Pyodide
   drains stdin greedily and one `input()` would prompt several times.
   Browsers forbid `TextDecoder` on a SharedArrayBuffer view, so the
   worker copies the bytes into a private buffer before decoding.

On the **web** host this needs **cross-origin isolation**
(`SharedArrayBuffer`), which `pnpm run test-web` already enables with
`--coi`. On **desktop**, Pyodide lives in a `worker_threads` Worker so
`Atomics.wait` does not freeze the extension host. If a SAB cannot be
created, `input()` raises instead of hanging.

## Stopping a running program

A program that never finishes used to wedge the whole extension. The worker
sits inside a synchronous `runPython`, so it cannot read another message,
`request()` never settles, and `ReplSession`'s exec chain never advances -
so every later run, in every file, waits behind it. Only a window reload
recovered.

`interruptBuffer.ts` is the fix, and it is the same shape as
`stdinBuffer.ts`: a small `SharedArrayBuffer` passed to the worker on
`init` and handed to Pyodide via `setInterruptBuffer`. Writing SIGINT (2)
into its first byte makes the interpreter raise `KeyboardInterrupt` at its
next bytecode check. It has to be shared memory for the same reason stdin
does - the thread we need to reach is blocked.

Pyodide's check reads that byte and then writes 0 over it, in two separate
steps, so a Stop written between them is erased and the program runs on.
A Stop is therefore re-asserted every `INTERRUPT_RETRY_MS` until PLL's
SIGINT handler, installed by the bootstrap, sets the second byte to
acknowledge it - and only while a request that was running when Stop was
pressed is still running, so a retry cannot carry over into whatever runs
next. The handler consumes repeats of a Stop it has already raised, so a
retry that loses the race with the acknowledgement does not raise a second
`KeyboardInterrupt` into PLL's own clean-up.

`_pll_run_file` catches `BaseException`, so a Stop in the student's code
arrives as an ordinary error result (`error_type: "KeyboardInterrupt"`)
with the `finally` still capturing whatever the program printed first, and
the analyzer words it "The program was stopped." A Stop retried into the
moment a run starts can instead land while PLL is still parsing and
instrumenting the file, outside that `except`; `_pll_stoppable` turns one
there into the same stopped result, for a file, a prompt line or the tests.

`PythonRuntime.interrupt()` is synchronous - there is no point posting a
message to a blocked thread - and returns false when no buffer could be
created, so the host can say so rather than appear to work. The worker
clears the buffer before every request, so a Stop that nothing took
(pressed as a program finished, or while files loaded) cannot fire into
whatever runs next - usually the next run's static checks. The retry is
what makes that safe: a Stop meant for the request itself is put back.

### A Stop ends the whole run

A file run is several steps - libraries and files load, the Examplar
check, the file's own tests, then the program - and a Stop lands in
whichever is running. What the student asked for is that nothing more
runs. `_pll_run_tests` treats `KeyboardInterrupt` as the end of the test
phase: the tests that finished keep their results, the one running is
marked `stopped`, and the rest are not run. `runPlan.ts` checks the host's
`stopRequested()` between the steps and ends the run with a banner saying
what was not run. The same checks catch a Stop
pressed while something loads, which reaches no running Python at all and
used to be lost. A step that fails *because* of a Stop - static analysis,
or loading pytest, interrupted part-way - reports the Stop, not a failure
of its own.

Two limits are inherent to the mechanism, and PLL reports them rather than
hiding them: the check happens between Python bytecodes, so a tight loop
inside a C extension does not yield until it returns, and student code with
a bare `except:` can swallow the interrupt exactly as it would in CPython.
If the program is still running `STOP_TIMEOUT_MS` after a Stop, the
interactions view says so and points at reloading the window. Terminating
and respawning the worker would cover those cases; it is deliberately not
implemented, because one interpreter is shared by every session and killing
it discards all of their globals.

A Python that is *already* gone is another matter, since there is nothing
left to discard. If the Node worker exits, or the interpreter in any worker
can no longer run (Pyodide refuses every call after a fatal error, and the
worker marks such a reply `finished`), the runtime fails the request in
flight with `PythonLostError`, ends that worker, and starts a new one for
the next request; every file that has run says that its names are gone.
`os._exit()` and `os.abort()`, which would end the interpreter, are
replaced (in `bootstrap/running.py`) by an exit like `sys.exit()`'s, so a
program calling them ends and Python carries on.

### Why output has to be throttled

Making Stop actually work needed two limits that have nothing to do with
signals. `while True: print("hello")` calls `_pll_live_emit` on every write,
which posted a few hundred thousand `display` messages per second - faster
than the extension host could drain them, so its queue grew without bound
and the Stop the student pressed was never processed. The interrupt was
working the whole time; nothing ever got around to asking for it.

`workerHost` therefore coalesces consecutive stdout/stderr writes into at
most one message per `LIVE_FLUSH_MS` (50ms), turning that same second of
output into about 20 messages. Images and tables flush the pending text
first, so the interleaving of output and cards is unchanged, and `readStdin`
flushes before parking on the SAB - otherwise the prompt of
`input("Choice: ")` could sit in the buffer while the program waits for a
line the student has not been asked for. `smoke-interrupt` asserts both the
message count and that the live stream still delivers every byte exactly
once.

Coalescing alone is not enough, because every layer below it still did work
per line. Four limits are involved, and they fall into two kinds - **rate**
limits, which bound work per unit time, and an **accumulation** limit, which
bounds the total. Each is load-bearing; none substitutes for another:

| constant / change | kind | bounds |
| --- | --- | --- |
| `LIVE_FLUSH_MS` (50ms, workerHost) | rate | worker -> host messages |
| `APPEND_FLUSH_MS` (16ms, interactionsView) | rate | host -> webview messages |
| `_pll_push` live/batch split | accumulation | the Python display list |
| `MAX_STREAM_LINES_PER_RUN` (5000) | accumulation | entries and DOM nodes |

`APPEND_FLUSH_MS` was the largest single win. Each append used to be its own
IPC hop, after which the view called `persist()` - `vscode.setState` over
the whole entry log, so O(n) per entry - and forced a layout by scrolling.
Batched into one `appendMany`, that is one persist, one `DocumentFragment`
insertion and one scroll per frame. Anything that is not an append flushes
the queue first, so a `clear` or `busy` update cannot overtake output that
was already produced; `clear` and `showSession` discard the queue instead,
since its entries are gone or already included in the replay.

The `_pll_push` split matters for a subtler reason. It used to append to
`_pll_displays` *and* emit live, but in live mode the host discards
`result["displays"]` - so a printing loop built a multi-million entry list
that was copied by `list()`, converted dict-by-dict to JS by `toJs`, and
then dropped. That cost grows with total output, not with its rate, so no
amount of rate limiting touches it.

Measurements, from `pnpm run test-web:stop` with a 6s soak (click to
`KeyboardInterrupt`):

| configuration | Stop latency |
| --- | --- |
| per-entry appends (original) | 16,976 ms |
| batched appends, `_pll_displays` still accumulating | 3,453 ms |
| both fixed | 341 ms |
| both fixed, `MAX_STREAM_LINES_PER_RUN` removed | panel wedged; Playwright could not even count its DOM nodes after 1.5s of output |

That last row is why the cap stays. With the rate limits in place each
*message* is cheap, but every line is still a DOM node and an entry in the
view's `state.entries`, which `persist()` reserializes per batch - so
unbounded output is quadratic again, and the DOM alone kills the panel. The
cap is the only limit that bounds the total.

Worth recording how misleading the guesses were. `feedStream`'s repeated
`substring` looks quadratic and was the first suspect; V8's sliced strings
make it about 1.6ms per 67 KiB chunk, roughly 3% of one core. Measure here
rather than reason about it.

The affordance is a **Stop** button in the input row, shown only while a
program runs, plus Ctrl/Cmd+C in the panel and **PLL: Stop Program**. The
button is not decoration: while a program runs the input `textarea` is
`disabled`, and a disabled textarea receives no key events, so the panel's
existing Ctrl+C handler cannot fire. `main.js` therefore also listens on the
document while blocked, skipping the interrupt when there is a selection so
copying output still works.

## Development

```bash
pnpm install
pnpm run build         # one-shot build (also copies Pyodide assets into vendor/)
pnpm run watch         # rebuild on change
pnpm run vsce:package  # produce a .vsix (runs vscode:prepublish first)
pnpm run smoke         # build, then the whole smoke suite (below)
```

### Smoke tests

`pnpm run smoke` builds and then runs `scripts/smoke-*.mjs` in order.
Three of them cover the host-side TypeScript with no Pyodide involved:

- `smoke-repl-session.mjs` — `ReplSession` against a fake runtime and a
  recording view, with `vscode` aliased to a stub: per-file sessions,
  the multi-line prompt buffer, static-check gating, stream line
  batching, the `input()` handshake, sibling-file syncing.
- `smoke-worker-protocol.mjs` — `WorkerPythonRuntime` against a scripted
  in-process worker: request/reply correlation, error propagation, live
  display streaming, the stdin round-trip.
- `smoke-new-file-level.mjs` — `newFileLevel.ts` against a stub filesystem:
  which new files get a header, which are left alone, and that what it
  writes parses back to the level that was asked for.

`smoke-typecheck.mjs` spans both halves: it drives the built desktop
worker for the instrumentation and then feeds the real typeguard messages
and tracebacks through the host-side analyzer, so the rewritten wording
and the blamed line are both asserted.

The rest boot real Pyodide in Node: `smoke-static-analyze`,
`smoke-explainers`, `smoke-images`, `smoke-tables`, `smoke-tests`,
`smoke-pandas` (incl. a URL read), `smoke-typecheck`, `smoke-input`,
`smoke-workspace-files`, `smoke-interrupt`, and `smoke-desktop-parity` (the
built desktop worker, end to end).

`smoke-examplar` covers the directive and the fetch path against a real
HTTP server, because what matters there is conditional requests and what
happens when the server is *gone* - neither of which a hand-written fake
would get right by accident. `smoke-examplar-build` drives
`pll examplar build` for the authoring half, including that a bundle
contains no source text, that `--verify` refuses an unsound one, and that a
suite with a program attached to it still produces a verdict.

`samples/examplar_bundle` is the worked example of the authoring workflow -
two wheats, six chaffs, and the staff suite that verifies them - and
`smoke-examplar-build` [9] keeps it honest: the bundle must verify, and
`samples/examplar.py` must pass every wheat while still missing chaffs 2-5.
Documentation rots, and this is documentation that a change to a wheat could
quietly break.

`pnpm run test-web:load` covers `load_table` and `load_image` in a real
workbench, from files beside the program and from a URL. Two of those four
paths exist only in a browser and nothing else reaches them: a local
picture arrives through the editor's own collector (`workspaceFiles.ts`,
over `vscode.workspace.fs`), a different code path from the CLI's; and a
fetched one is decoded by a real `XMLHttpRequest`, which honours the
`x-user-defined` request and remaps every byte above 0x7f for
`_pll_fetch_bytes` to mask back. The desktop polyfill ignores that request
and returns one character per byte, so the mask is a no-op there and every
command-line test passed without the mapping ever running - on a PNG, whose
first byte is 0x89. The test therefore pulls the data URI back out of the
rendered SVG and checks the byte count and signature, rather than trusting
that a plausible-looking width means the bytes survived.

`pnpm run test-web:examplar` is the only test that sees the two halves meet.
It builds a bundle with the CLI, serves it from a correctly configured
localhost server, and runs four files in the workbench: a finished suite, a
suite with a gap in one function and nothing at all for the other, a test
that expects the wrong answer, and a test that opens a data file - the last
of which also checks that one function being held back leaves the other
scored. Three things only it can check - that CLI-built bytecode
loads in the extension's Pyodide (the whole claim behind compiling inside
Pyodide), that the fetch survives the browser's CORS rules (the cached badge
on the second run is the assertion), and that the cards reach the screen
naming a disagreeing test without its assertion, and a missed chaff by id
alone. It builds the bundle each run rather than checking a fixture in,
which would rot the next time Pyodide moves.

`smoke-cli` runs the built `pll` binary as a child process on fixtures in a
temp folder, which is the only way to cover what a user actually invokes:
argument handling, the split between program output and commentary, all five
exit codes, stdin, sibling files, and the two things that cannot work in a
terminal. It also checks Ctrl+C stops a runaway loop, signalling once the
program has demonstrably started rather than on a timer.

`smoke-universe` runs the world-side client against a real WebSocket
server, hand-rolled in the test (handshake plus text framing, about 60
lines) so there is no dependency and so the test doubles as a statement of
how small a conforming server is. It covers both directions, a payload past
the 125-byte frame boundary, a server that hangs up, and an address nobody
is listening on - asserting the failure message is not empty, since neither
platform provides one.

`pnpm run test-web:reactor` drives a real webview: that the card animates at
roughly the tick rate, that pause / step / rewind / replay work, that an
arrow key reaches Python, that `stop_when` stops the clock, and that the
prompt still works while three reactors run.

`pnpm run test-web:universe` starts `samples/universe_server.mjs` and runs
`samples/universe.py` against it in the workbench, checking the card reports
`connected`, that an arrow key's `package(...)` arrives at the server, and
that a message from another client reaches `on_receive`. It uses the
reference server rather than a purpose-built one, so it also verifies that
the server we hand out works with the client we ship. (It needs port 8080,
which is what the sample registers with.)

`smoke-interrupt` covers the mechanism, because the failure it guards
against - the worker never returning - cannot be reproduced against a fake
runtime. It starts a real `while True: pass` in the built desktop worker and
interrupts it through the buffer.

`pnpm run test-web:stop` covers the *click*, in the real workbench with a
real webview, and it is not redundant: the bug that shipped first was not
the signal but the flood. A printing loop saturated the extension host, so
the button was visible and enabled and the click still never arrived.
Nothing below the webview can catch that. The script opens
`samples/runaway.py`, runs it, clicks **Stop**, and checks the program ends
with `KeyboardInterrupt`, the output notice appears, and the prompt still
accepts a submission afterwards. Setting `LIVE_FLUSH_MS` to 0 and
`MAX_STREAM_LINES_PER_RUN` very high makes it fail again, with Playwright
timing out on the click itself.

It asserts a `STOP_LATENCY_BUDGET_MS` (3000ms) on the time from click to
`KeyboardInterrupt`, which matters more than it sounds: with per-entry
appends the Stop *did* eventually land, so a test that only waited for the
interrupt passed while the feature was unusable. It also soaks for
`STOP_SOAK_MS` (4s) before clicking, because the accumulation costs are
invisible if you press Stop immediately - that soak is what exposed
`_pll_displays`.

### Desktop extension

Open this folder in VS Code and press **F5** → *Run Extension (Desktop)*.
A second window opens with the extension loaded.

### Web extension (primary target)

Three options, in increasing order of how close they are to production:

1. **F5 → *Run Extension (Web)*** in desktop VS Code. Uses
   `extensionDevelopmentKind=web` so the extension host runs the web
   bundle (`dist/web/extension.js`) and a real `Worker`. Fastest
   iteration loop; full debugger.

2. **`pnpm run test-web`** spins up a local copy of `vscode-web` (the
   build behind `vscode.dev`) and opens it in Chromium with the
   extension preloaded.

   ```bash
   pnpm run test-web              # download Chromium if needed, build,
                                  # then open vscode-web in Chromium
   pnpm run test-web:server       # build + run server on :3000 only
   pnpm run setup:browser         # one-time: download Playwright Chromium
   ```

   The script enables `--coi` (cross-origin isolation) so Pyodide's
   workers / SharedArrayBuffer features work. It also grants
   `--permission=clipboard-read` / `clipboard-write` (COI otherwise
   blocks the clipboard API). That does **not** make editor
   Ctrl+C/V work; see [Clipboard](#clipboard-editor-and-interactions-panel).
   The workspace is `samples/` so you can open `hello.py`, `name_error.py`,
   `input.py` (interactive `input()`), `types.py` (runtime type
   checking), `pandas.py` (`pd.read_csv`,
   including a URL), `files.py` (`open` / `to_csv` on a sibling CSV), or
   `runaway.py` (a loop that prints forever, for testing **Stop**), or
   `scenes.py` (the xy / align / scene combinators). First
   run downloads vscode-web into `.vscode-test-web/` (~30 MB) and
   Playwright Chromium into `~/Library/Caches/ms-playwright/` (~150 MB);
   both are cached afterward.

   Iteration tip: `pnpm run watch` in one terminal, `pnpm run test-web:server`
   in another, then reload the browser tab.

   `package.json` enables Playwright's postinstall via
   `pnpm.onlyBuiltDependencies`. If you cloned with `--ignore-scripts`,
   run `pnpm run setup:browser`.

3. **Real `vscode.dev`** with the published or sideloaded extension.

## Clipboard (editor and interactions panel)

**Interactions panel:** Ctrl/Cmd+C/X/V and right-click work (0.0.5).
The workbench used to swallow those keys before the webview saw them.

**Editor (Monaco) on vscode-web:** keyboard copy/paste **works**. An
earlier version of this document said it was unsupported and abandoned;
that was wrong, and `pnpm run test-web:clipboard` now checks it.

How it works, and why it looks broken if you go looking for a command:
vscode-web registers `editor.action.clipboard{Cut,Copy,Paste}Action`
with **no keybinding**. In the shipped bundle the registration reads
`kbOpts: isNative ? {...} : undefined`, and `isNative` is false in web.
That is deliberate — with no keybinding intercepting the key, Chromium
fires its own `copy` / `cut` / `paste` events on the focused
`textarea.inputarea` that Monaco keeps in sync with the selection, and
the browser does the work without a clipboard permission prompt. So
there is no command to bind and nothing for an extension to fix.

Verified with `--coi` and clipboard permissions granted, against both
web builds `@vscode/test-web` can serve — stable 1.136.1 (what
vscode.dev ships) and insiders 1.137.0 — for a `.py` and a `.txt` file,
headed and headless, with no workspace settings and with
`editor.editContext` forced both true and false. Copy and paste
succeeded in every combination.

Two things that follow:

- **EditContext is a red herring.** In both builds Monaco used
  `textarea.inputarea` regardless of `editor.editContext`
  (`.native-edit-context` was never created), so PLL's
  `editor.editContext` / `experimentalEditContextEnabled` defaults are
  inert. They are kept only in case a future build flips over.
- **Do not bind Ctrl/Cmd+C/X/V** to `pll.editor.*` or to
  `editor.action.clipboard*Action`. There is nothing to gain — the keys
  already work — and a binding puts a command in front of the browser's
  native handling. If keyboard copy/paste is broken for you, a leftover
  binding in your own `keybindings.json` is the first thing to check;
  PLL does not write that file.

`pll.editor.*` (**PLL: Editor Copy/Cut/Paste**, via
`vscode.env.clipboard`) stays as a palette fallback. It earns its keep
in Firefox: `supportsPaste` there is
`document.queryCommandSupported("paste")`, which is false, so vscode-web
registers no paste action at all — not even a palette entry or context
menu item.

### Non-QWERTY layouts (Dvorak, Colemak, …)

If keyboard copy/paste does nothing in the browser, the layout is the
cause. Fix, in **user** settings:

```json
{
  "keyboard.dispatch": "keyCode"
}
```

By default VS Code resolves shortcuts from the *physical* key and, in
the browser, has no reliable way to learn your layout
(`navigator.keyboard.getLayoutMap()` can come back empty), so it assumes
US QWERTY. On Dvorak the `c` key is physically `KeyJ`, so Ctrl+C reads
as Ctrl+J — which unlike Ctrl+C *is* bound in web (toggle panel), so the
workbench swallows the key and the browser's native copy never runs.
`keyCode` dispatch resolves by character instead, and copy works.

It must be **user** settings: the setting is `APPLICATION` scope, so
workspace settings and extension `configurationDefaults` are both
ignored (tested). PLL therefore cannot ship this, and should not write
it on a student's behalf. macOS/Linux only, and it changes how every
shortcut resolves.

`pnpm run test-web:clipboard` drives the real workbench in Chromium via
Playwright and asserts select → copy → move → paste. Playwright's key
events go through Chromium's input pipeline as trusted events, which is
why they exercise the native clipboard path; the one thing it is not is
a physical key event arriving from the OS.

## Command line (`pll-python`)

`pll hw.py` runs a file with the same language levels, the same analyzers
and the same wording as the editor. It exists because the architecture
already allowed it: **everything below the orchestrator is `vscode`-free**.
Of the modules in `common/`, only nine import `vscode`, and the CLI needs
none of them - it reuses the worker protocol, all four Python libraries,
every analyzer and explainer, `errorFormatter` (which already renders plain
text), `level.ts`, and the stdin and interrupt buffers verbatim.

It is a third host beside `desktop/` and `web/`, and replaces exactly three
things:

| Editor | Command line |
| --- | --- |
| `interactionsView.ts` (webview) | `cli/view.ts` (text on stdout/stderr) |
| `workspaceFiles.ts` (`vscode.workspace.fs`) | `cli/files.ts` (`node:fs`) |
| `ReplSession` (sessions, exec chain) and `ReactorController` | `cli/run.ts` (one linear run) |

The run itself is shared, not copied: `runPlan.ts` holds the steps - the
`#level` line, static checks, libraries, files, Examplar, tests, the
program, write back - and each host supplies a `RunHost` saying how to show
a finding, a banner, a status, an event. The two used to each write the
sequence out, and drifted: they worded the same failures differently, the
CLI wrote files back after a failed mount, and the editor reported a
top-level error in a file with tests twice, and only the editor ran the
Examplar check; the CLI prints the same cards, from the same lines
(`examplarPhase.ts` words them; the panel and the terminal only draw
them). `DesktopPyodideRuntime` now takes its
asset and worker paths instead of deriving them, so both Node hosts share
the spawn; `desktop/pyodideWorker.ts` is reused **verbatim**, only bundled
to a second output path.

### Behaviour that differs, and why

- **Images do not render.** A terminal cannot draw SVG, so each prints
  `[image WxH]`, or `--save-images DIR` writes them out. Silence would look
  like a bug.
- **Reactors do not run.** Nothing drives the clock, so they would never
  animate; they print a note and the program continues. Their logic is
  still testable, because `simulate_trace(n)` needs no clock.
- **Tables do print**, as text. Unlike images their content is already
  text, and the Python side pre-formats every cell, so nothing is lost.
- **There is no `--level` flag.** The level lives in the file, so a file
  behaves the same everywhere; a flag would be exactly the fragmentation
  the level mechanism exists to avoid.

### Streams and exit codes

The program's own stdout is the only thing on stdout; everything PLL says
*about* the run goes to stderr. So `pll hw.py > out.txt` captures exactly
what the program printed. Exit codes are distinct so an autograder can tell
the cases apart: `0` ok, `1` the program raised (or Ctrl+C stopped it), `2`
level checks blocked it, `3` a test failed, `64` bad usage. A program that
ends itself with `sys.exit(n)` exits with `n`, as CPython would: Python
records the status in the result's `exit_code` (`_pll_exit_status`), the
`done` event carries it, and `runFile` returns it ahead of a test failure.

### Packaging

`pnpm run build` also assembles `dist-cli/`: two bundles, a generated
`package.json` (name, version and links derived from the extension's, so
they cannot drift), and the CLI readme. `pnpm run cli:pack` produces the
tarball; `cli:publish` publishes it. There is no second source tree and no
monorepo - the npm package is a build artifact.

`cli:publish` goes through `scripts/publish-cli.mjs`, which checks
`npm whoami` and runs `npm login --auth-type=web` first when there is no
token. That check is not politeness: an unauthorised `npm publish` is
answered with **404**, because the registry will not tell someone who may
not be allowed to see a package whether it exists. So "you have no token"
and "no such package" are the same message, and the script says which it
is instead of leaving that to be guessed. Rehearse with
`node scripts/publish-cli.mjs --dry-run`.

The package declares `node >=22`, which is a support decision rather than a
technical floor: the CLI bundle contains no `WebSocket` reference at all -
`universeClient.ts` is only reachable through `activate.ts` and the
editor's session (`replSession.ts`, `reactorController.ts`), none of which
the CLI imports - and `pyodide` itself
only asks for `>=18`. But 18 and 20 are both past end of life, so 22 is the
oldest Node we could support, and it matches what the extension already gets
from VS Code 1.101. One floor for the project instead of two.

`pyodide` is a real dependency rather than bundled, since the package needs
its `.wasm` and stdlib assets anyway; `require.resolve("pyodide")` finds
them at run time. That keeps the tarball at about 134 kB. Pyodide's Node
loader caches any wheels it downloads into that directory, so the first
`import pandas` needs the network and later ones do not.

## Examplar (wheats and chaffs)

[Examplar](https://dl.acm.org/doi/10.1145/3291279.3339408) assesses a test
suite rather than an implementation. A `#examplar <url>` directive names a
bundle of known-good implementations (**wheats**, on which every test must
pass) and known-bad ones (**chaffs**, each of which must be caught).

Everything is **per function**, because that is the unit a student works in.
A chaff declares which function it breaks - the author says so, by which
directory it lives in - and a chaff is judged **only by the tests of that
function**. A broken test of `total` fails on a chaff of `shout` too, and
crediting that would score the student for a signal with nothing to do with
the function.

Within a function it runs in **two phases, and the second is gated on the
first**: coverage is only measured once every test of that function *passes*
on every wheat. A test that disagrees with a correct implementation is
wrong, and a wrong test fails on *everything* - so it would "catch" every
chaff of its function and the number would flatter the student for their own
bug. A test that *raised* is no better: it raises the same way on every
implementation. Nothing short of a pass counts, because a suite is a
measuring instrument only once every test in it runs and agrees.
`_pll_examplar_run` returns `chaffs_skipped` - the function names it gave up
on - and does not run those chaffs at all.

Gating per function is the point of the split. A wrong test of `initials`
says nothing about how well `longest` is tested, so it must not hold that
report back; and a function with no tests gets a card that says only
*"No tests yet."* rather than a global count with a footnote contradicting
it.

That has a sharp edge worth knowing: the phase runs with the workspace
unmounted, so a test that opens a data file can never pass here, and its
function is held at phase one until the student changes it. The card says
exactly why (see the hint below), but it is a real cost of the unmount
rather than a detail.

Implementations travel as `.pyc` bytecode inside a single JSON bundle -
one URL, because every wheat and chaff defines the *same* function names and
so cannot come from one file:

```json
{ "examplar": 2,
  "built": { "python": "3.13.2", "magic": "f30d0d0a" },
  "provides": ["shout", "total"],
  "wheats": [{ "id": "reference", "pyc": "<base64>" }],
  "chaffs": [{ "id": "1", "targets": "shout", "pyc": "<base64>" }] }
```

`targets` comes from the authoring layout - `chaffs/shout/1.py` - rather
than from inference. Nothing can work it out reliably: a chaff is a whole
file, and the functions it leaves alone still differ from a wheat's by
whitespace. The author knows, so the author says.

Bytecode is tied to the Python minor version, so bundles are compiled
**inside Pyodide** by `pll examplar build` - the CLI pins the same Pyodide
the extension does, which makes the magic number match by construction
rather than by asking course staff to keep a matching CPython. `built.magic`
is carried so a stale bundle reports *"built for Python 3.9 and cannot run
here"* instead of `ValueError: bad marshal data`.

`examplarLib.py` holds both primitives, shared by the editor and the command
line: `_pll_examplar_build` (authoring) and `_pll_examplar_run`, which execs
the student's file, overlays an implementation so its names win, and calls
each `test_*`. That overlay *is* the Examplar semantics - their tests are
judged against the given implementation, not their own attempt.

Two details that earn their place:

- The student's tests are compiled **once**, through pytest's
  `rewrite_asserts`, and the code object reused for every implementation, so
  N chaffs cost one compile. The rewriting is for `--verify`, where the
  reader is the author: `assert 'HI!' == 'hi!'` is what tells them their own
  test is wrong.
- **Say which thing is wrong, never what is right.** Chaff failure messages
  describe the planted bug, so students get caught/missed and an id. Wheat
  failure messages state the correct *answer*, so students get the failing
  test's name and nothing more - a card carrying `assert 'HI!' == 'hi!'` is
  an oracle, and the assignment can be read off it one deliberately-wrong
  test at a time. Both messages survive on the raw result for `--verify`;
  neither is copied into an entry, so neither can reach the webview.

`--verify` checks the property nothing else can: the author's own suite
passes on every wheat and fails on every chaff. A chaff no test catches
would silently never count.

### A card per function

`buildExamplarEntries` returns one entry per provided function, and the
panel renders each as a card headed by the function name, with a line per
phase: *"Against correct implementations: ..."* then *"Against buggy
implementations: ..."*. The function **leads** the header and "Examplar"
sits small on the right - the function is what the student is working on and
what tells one card from the next.

`ExamplarEntry` is a union on `card` (`function` | `failed`), so a
whole-bundle problem collapses to one card rather than a row of
half-populated ones. Attribution decides which card a test lands on, and it
is closed over the student's own helpers: a test that calls
`check(name, expected)` which calls `initials` belongs on the `initials`
card, and a plain free-variable scan would file it under nothing and
silently leave it off every card. It stops at a provided name rather than
descending into it - during the phase that name is the bundle's function.

Where the bundle came from is that small label's `title`, not a visible
badge of its own. It
used to read *"known implementations (cached)"*, which was misleading: cached
here means a 304, so the bundle is *current* rather than stale. The case
worth saying out loud - an unreachable server and a fallback to an older copy
- already gets a banner.

### The phase in a run

The run plan runs the Examplar step (`examplarPhase.ts`) once libraries and
files are loaded, in the editor and on the command line alike. It fetches the bundle (so a fetch failure is reported once) and runs
the phase; the plan then mounts the files again:

```
static checks -> files -> [ fetch -> unmount -> examplarRun ] -> remount -> own tests -> the program
```

The workspace is **unmounted** for the phase (`mountWorkspaceFiles([])`).
A bundle is code from a URL; a course is trusted, but there is no reason for
it to be able to read - or rewrite - a student's data files while it runs.
The siblings go back before anything of the student's runs.

That unmount has a student-visible cost, and three decisions pay for it:

- **Only the student's *definitions* run in the phase.** Their file is their
  program as well as their tests, and the phase wants the second half of
  that. It is also run once per implementation, so running the program too
  would mean one copy of every side effect per wheat and chaff - and a
  top-level `input()` would block the check forever, because nothing is
  listening for stdin during it. `_pll_examplar_compile_tests` keeps the
  top-level statements that bind names (imports, `def`, `class`,
  assignments) and compiles **one code object per statement**, so a
  definition that cannot load here - `DATA = open("data.csv").read()` - costs
  only itself instead of the whole verdict. Anything that needed it then
  raises its own `NameError`, which says so.
- **A test that *raised* is not a test that is wrong.** `fail` and `error`
  are different verdicts on the phase-one card: a test that fails an
  assertion on a
  known-correct implementation expects the wrong answer, while a test that
  raised never got as far as having an expectation. Saying "you expect the
  wrong answer" over a `FileNotFoundError` would be a false accusation. When
  one of those errors is a file-access error, it adds the one thing the
  student cannot deduce - that their files are not there during the check.
- **A test that raised catches nothing.** It raises the same way on every
  implementation, so crediting it would score the student for a signal made
  entirely of our own unmounting. It is excluded from the chaff count. A test
  that *disagrees* still counts: it ran, and it did tell them apart.

`runExamplarStep` returns whether the student defines every name the bundle
provides (`student_defines`, recorded before the overlay). That gates only
the *other* test phase: running a file's `test_*` against the code in that
same file needs that code to exist, or every test reports a `NameError`
under a perfectly good verdict. Nothing is said about its absence, because
writing tests before any implementation is the point rather than a mistake.

### What a course server has to send

On the desktop the fetch happens in Node. In the **web** build the extension
host is a browser, so a bundle is a cross-origin request and three headers
are load-bearing:

| Header | Without it |
| --- | --- |
| `Access-Control-Allow-Origin` | no bundle at all |
| `Access-Control-Expose-Headers: ETag` | `headers.get("etag")` reads null, so nothing is ever cached |
| `Access-Control-Allow-Headers: If-None-Match` | the conditional request fails its preflight, so students stay pinned to the copy they cached first |

`If-None-Match` is not a CORS-safelisted *request* header, so the second and
every later fetch is preflighted; `ETag` is not a safelisted *response*
header, so it is invisible to script unless exposed. Both failures are
silent and neither breaks the feature outright, which is exactly why
`test-web:examplar` asserts the cached badge on a second run rather than
trusting the code to be right.

### How hidden the implementations are

Measured, not assumed: `inspect.getsource` raises, but `co_consts` shows
literals, `dis` works, and the bundle can simply be read back out of MEMFS.
Bytecode is a speed bump. This is accepted rather than overlooked - the
autograder holds the grade, so the in-editor check needs to be fast and
honest, not secret. Compiling to a wasm extension module would be genuinely
opaque but pins *four* things (`cp313`, the Pyodide ABI, emscripten, wasm32)
where `.pyc` pins one, and Cython-compiled Python is not byte-identical to
interpreted Python - a wheat that behaves differently from the autograder's
would be far worse than a readable one.

### The directive

`#examplar <url>` is matched as a whole line, anywhere in the file, and two
of them is an error rather than "first wins". It is deliberately *not* part
of a header block: `parseLevel` has strict, tested semantics, and this way
adding the directive cannot perturb how a file's level is read. Only `https`
is accepted, except on localhost for authoring.

Bundles are fetched host-side with a conditional request and cached by URL.
Offline with a cached copy is a note; offline without one is an error and
the file still runs - the same fail-open stance as every other optional
layer here.

## Minimum VS Code version

`engines.vscode` is `^1.101.0` (June 2025). That is the first release whose
extension-host Node is 22, and therefore the first with a global
`WebSocket` - Node 22.0 removed the `--experimental-websocket` flag and 22.4
marked it stable. 1.101 ships Node 22.15.1.

The floor is deliberately a version requirement rather than a runtime
fallback. Supporting older builds meant a feature-detected optional `ws`
dependency and a code path that could only ever report that universe was
unavailable - two behaviours for one feature, which is the fragmentation
this project tries not to accumulate. The trade is explicit: VS Code older
than June 2025 cannot install PLL at all, rather than installing and then
being unable to connect.

`@types/vscode` stays at `^1.85.0`. It has to be **at or below**
`engines.vscode` for `vsce` to package, and nothing here uses API added
since.

## Configuration

- `pll.pyodideIndexUrl` — base URL for Pyodide assets (web only).
  Defaults to the matching pinned CDN build.
- `pll.newFileLevel` — `#level` line to put in newly created `.py` files.
  Defaults to `none`. A template for new files only; it does not change what
  a file without a level line means (always `raw`).

Note what is deliberately *absent*: there is no setting for what gets
checked. That is the level's job, and only the level's, so nothing can
disagree with what the file says.

PLL declares `untrustedWorkspaces` and `virtualWorkspaces` support in
`package.json`, so Restricted Mode and vscode.dev do not disable it per
folder. A handout `.vscode/settings.json` cannot do that:
`extensions.supportUntrustedWorkspaces` is a **user** setting. Course
repos should still list `"pll.python-language-levels"` in
`.vscode/extensions.json` `recommendations` so first-time students get
an install prompt.

## Editor defaults

PLL ships opinionated `configurationDefaults` so beginners mostly see
what the extension turns on. These are *defaults only* — PLL never
writes the user's `settings.json` or `keybindings.json`, and a setting
the user changes still wins.

Kept on:

- Syntax highlighting (built-in TextMate grammar)
- Line numbers, bracket matching, indent guides
- Auto-closing brackets / quotes
- The Problems panel (so friendly errors show up)
- The PLL interactions view and **PLL: Run Python File**

Turned off for `[python]` files:

- Autocomplete popups: `editor.quickSuggestions`,
  `suggestOnTriggerCharacters`, `tabCompletion`, `wordBasedSuggestions`,
  `parameterHints`, `snippetSuggestions`, `suggest.showWords` /
  `suggest.showSnippets`
- Inline AI suggestions: `editor.inlineSuggest.enabled`,
  `github.copilot.enable.python`,
  `github.copilot.editor.enableAutoCompletions`,
  `cursor.cpp.disabledLanguages` (Cursor Tab) — best-effort across forks
- CodeLens, lightbulb (quick-fix), minimap, sticky scroll, linked editing
- Format on save / paste / type

Turned off globally (no-ops if the other extension is not installed):

- Microsoft Python legacy linting:
  `python.linting.{enabled,pylintEnabled,flake8Enabled,mypyEnabled,banditEnabled,pycodestyleEnabled,pydocstyleEnabled}`
- Pylance: `python.languageServer = None`,
  `python.analysis.{autoImportCompletions,typeCheckingMode,completeFunctionParens,indexing,useLibraryCodeForTypes,diagnosticMode}`
- Standalone linters/formatters via `ignorePatterns: ["**"]`:
  `pylint`, `flake8`, `bandit`, `mypy-type-checker`, `ruff`
- `matangover.mypy` (no real off switch in settings) —
  `mypy.runUsingActiveInterpreter`, `mypy.checkNotebookFiles`,
  `mypy.checkAllOpenFolders`, `mypy.targets: []`. **This can still
  trigger on save** for the active file; see the extension guard below.
- Pyright family: `pyright.disableLanguageServices` +
  `pyright.disableOrganizeImports`, plus the same pair for `basedpyright`
- Formatters: `black-formatter.formatOnSave`, `isort.formatOnSave`
- Other noise: `python.terminal.activateEnvironment`,
  `python.experiments.enabled`, `python.showStartPage`,
  `breadcrumbs.enabled`

### Extension guard

Some Python extensions emit diagnostics regardless of settings. The
worst case is **`matangover.mypy`**, which has no `enabled` and no
`ignorePatterns`; the only fix is to disable the extension.

On activation, the
[extension guard](https://github.com/dbp/pll/blob/main/src/common/extensionGuard.ts)
scans for known conflicts (`ms-python.python`,
`ms-python.vscode-pylance`, `matangover.mypy`,
`ms-python.{mypy-type-checker,pylint,flake8,bandit}`,
`ms-pyright.pyright`, `detachhead.basedpyright`, `charliermarsh.ruff`)
and shows one warning with:

- **Show & Disable** — opens each extension's details page so the user
  can *Disable (Workspace)*, then offers to reload.
- **Don't ask again** — stores dismissal in workspace state.

VS Code itself still recommends Microsoft's Python extension when a
`.py` file is opened, and **no extension can suppress that**. The
recommendation lives in the workbench's own product config
(`extensionRecommendations`) as `{pathGlob: "{**/*.py}", important:
true}` with no `whenNotInstalled` list. Other languages do have one —
Java defers to `Oracle.oracle-java`, C++ to `vscode-clangd` — so the
opt-out mechanism exists; Python's entry just doesn't use it. Installing
PLL therefore cannot register it as an alternative.

What does work is per-workspace, as in `samples/.vscode/extensions.json`:

```json
{
  "recommendations": ["pll.python-language-levels"],
  "unwantedRecommendations": ["ms-python.python", "ms-python.vscode-pylance"]
}
```

A user can also set `"extensions.ignoreRecommendations": true`, which
silences *all* recommendation prompts. That one is window-scoped, so
unlike `keyboard.dispatch` PLL could ship it in
`configurationDefaults` — it is left out deliberately, as suppressing
every recommendation is broader than the problem.

If those extensions are already installed, the guard prompts the user to
disable them for the workspace.

### Manual leftovers

Some tools ignore both `configurationDefaults` and the detector:

- Cursor Tab: besides `cursor.cpp.disabledLanguages`, you may need
  **Cursor Settings → Features → Tab**.
- Other AI assistants (Codeium, Tabnine, …): disable per-language or
  per-workspace in that extension's settings.
- Unwanted workspace extensions: **Extensions: Disable (Workspace)**.

Override anything in `.vscode/settings.json`; user/workspace values
always win.
