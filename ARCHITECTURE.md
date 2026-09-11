# PLL architecture and development

This document is for people working on Python Language Levels, not for
students using the extension. For how to *use* PLL, see [README.md](README.md).

PLL runs Python with [Pyodide](https://pyodide.org) inside VS Code. The
same interactions UI works in **desktop VS Code** (Node host) and
**vscode.dev** (web extension host).

## Layout

Both hosts share everything except how they spawn a worker and where
Pyodide's assets come from. `common/workerRuntime.ts` and
`common/workerHost.ts` hold the two ends of the worker protocol; the
`desktop/` and `web/` files below them are thin adapters.

```
src/
├── extension.ts                   Desktop entrypoint (Node host)
├── web/extension.ts               Web entrypoint (vscode.dev)
├── web/pyodideWorker.ts           Browser Worker: boots Pyodide via importScripts
├── web/pyodideRuntime.ts          Spawns the browser Worker
├── desktop/pyodideWorker.ts       Node worker_threads Worker: boots Pyodide
├── desktop/pyodideRuntime.ts      Spawns the Node worker; finds vendor/pyodide
├── desktop/xhrPolyfill.ts         Sync XMLHttpRequest for pyodide-http
├── desktop/syncHttp.ts            Child-process fetch used by the XHR polyfill
└── common/
    ├── activate.ts                Shared activation for both hosts
    ├── workerProtocol.ts          Shared worker message types
    ├── workerRuntime.ts           Host side of the protocol: request/reply
    │                              correlation, live displays, stdin
    ├── workerHost.ts              Worker side of the protocol: one Pyodide
    │                              interpreter + the message dispatch
    ├── stdinBuffer.ts             SharedArrayBuffer protocol for input()
    ├── workspaceFilePolicy.ts     Which sibling files to mount / write back
    ├── workspaceFiles.ts          vscode.workspace.fs snapshot + writeback
    ├── memfsWorkspace.ts          Pyodide MEMFS mount / collect helpers
    ├── commands.ts                Run File / Show Interactions / Clear commands
    ├── editorClipboard.ts         Palette PLL: Editor Copy/Cut/Paste (no keys)
    ├── replSession.ts             Drives the interactions view: init,
    │                              REPL multi-line buffer, file runs, exec chain
    ├── interactionsView.ts        WebviewView provider for the integrated
    │                              text + image stream + input row
    ├── level.ts                   #beginner / #intermediate / #advanced header parser
    ├── errorFormatter.ts          Plain-text rendering for diagnostic tooltips
    ├── diagnostics.ts             VS Code DiagnosticCollection (multi-finding)
    ├── pyodideRunner.ts           Bootstrap loader + types
    ├── pythonVendor.ts            Bundled typeguard / typing_extensions wheels
    ├── deliverResult.ts           Translates Python results to ExecutionEvents
    ├── pyodideBootstrap.py        Real Python: run / repl-eval / tests / static analyzer
    ├── imageLib.py                Real Python: SVG image primitives + combinators
    ├── tableLib.py                Real Python: Table type + charts
    ├── analyzers/
    │   ├── types.ts               AnalysisFinding, RuntimeAnalyzer
    │   ├── nameErrorAnalyzer.ts   Runtime: NameError -> friendly finding
    │   ├── typeCheckAnalyzer.ts   Runtime: TypeCheckError -> friendly finding
    │   ├── registry.ts            Runtime analyzer registry
    │   └── static/
    │       ├── shadowingExplainer.ts            shadowing + shadowing-builtin
    │       ├── reassignmentExplainer.ts         reassignment
    │       ├── disallowedKeywordExplainer.ts    `global` / `nonlocal`
    │       └── registry.ts                      Wraps Python-side raw findings
    └── errors/
        ├── pythonErrorParser.ts
        ├── nameErrorExplainer.ts
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
in `pyodideBootstrap.py`. esbuild's `text` loader inlines that file as a
string at build time so it is loaded into Pyodide once on init. Analysis
therefore runs in the same Python interpreter that runs the user's code,
in both desktop and web hosts.

Prompt submissions use the language level of the last Run File
(`session.lastLevel`, shown in the interactions header), or `advanced`
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

## Runtime type checking

Annotations are checked while the program runs, at every language level,
unless `pll.runtimeTypeChecking` is false. The work is done by
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

At `#beginner` and `#intermediate`, a `bool` is rejected where `int` or
`float` is annotated. Python makes `bool` a subclass of `int`, and both
mypy and typeguard follow it, so `count: int = True` is normally accepted;
at the teaching levels that is a hole worth closing, since a student who
annotates `int` and passes `True` has almost always made a mistake. It is
implemented as a `checker_lookup_functions` entry (typeguard's public hook)
that replaces the `int` and `float` checkers, gated on a module flag that
`_pll_apply_level` sets per run from the level the host passes in — so
`#advanced` keeps Python's own rule, and the lookup is consulted on every
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
- typeguard's union failures span several lines and `parsePythonError`
  keeps only the first, which is exactly the part naming the accepted
  types; `typeCheckAnalyzer` recovers the rest from the traceback.

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

1. **Live output.** `_pll_push` in `pyodideBootstrap.py` optionally
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
Two of them cover the host-side TypeScript with no Pyodide involved:

- `smoke-repl-session.mjs` — `ReplSession` against a fake runtime and a
  recording view, with `vscode` aliased to a stub: per-file sessions,
  the multi-line prompt buffer, static-check gating, stream line
  batching, the `input()` handshake, sibling-file syncing.
- `smoke-worker-protocol.mjs` — `WorkerPythonRuntime` against a scripted
  in-process worker: request/reply correlation, error propagation, live
  display streaming, the stdin round-trip.

`smoke-typecheck.mjs` spans both halves: it drives the built desktop
worker for the instrumentation and then feeds the real typeguard messages
and tracebacks through the host-side analyzer, so the rewritten wording
and the blamed line are both asserted.

The rest boot real Pyodide in Node: `smoke-static-analyze`,
`smoke-explainers`, `smoke-images`, `smoke-tables`, `smoke-tests`,
`smoke-pandas` (incl. a URL read), `smoke-typecheck`, `smoke-input`,
`smoke-workspace-files`, and `smoke-desktop-parity` (the built desktop
worker, end to end).

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
   including a URL), or `files.py` (`open` / `to_csv` on a sibling CSV). First
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

## Configuration

- `pll.pyodideIndexUrl` — base URL for Pyodide assets (web only).
  Defaults to the matching pinned CDN build.

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
