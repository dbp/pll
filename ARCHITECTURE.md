# PLL architecture and development

This document is for people working on Python Language Levels, not for
students using the extension. For how to *use* PLL, see [README.md](README.md).

PLL runs Python with [Pyodide](https://pyodide.org) inside VS Code. The
same interactions UI works in **desktop VS Code** (Node host) and
**vscode.dev** (web extension host).

## Layout

```
src/
├── extension.ts                   Desktop entrypoint (Node host)
├── web/extension.ts               Web entrypoint (vscode.dev)
├── web/pyodideWorker.ts           Browser Worker that hosts Pyodide
├── web/pyodideRuntime.ts          Talks to the browser worker
├── desktop/pyodideWorker.ts       Node worker_threads Worker that hosts Pyodide
├── desktop/pyodideRuntime.ts      Talks to the Node worker
├── desktop/xhrPolyfill.ts         Sync XMLHttpRequest for pyodide-http
├── desktop/syncHttp.ts            Child-process fetch used by the XHR polyfill
└── common/
    ├── workerProtocol.ts          Shared worker message types
    ├── stdinBuffer.ts             SharedArrayBuffer protocol for input()
    ├── workspaceFilePolicy.ts     Which sibling files to mount / write back
    ├── workspaceFiles.ts          vscode.workspace.fs snapshot + writeback
    ├── memfsWorkspace.ts          Pyodide MEMFS mount / collect helpers
    ├── commands.ts                Run File / Show Interactions / Clear commands
    ├── editorClipboard.ts         Palette PLL: Editor Copy/Cut/Paste (no keys)
    ├── editorDefaults.ts          Clear leftover web C/V bindings; EditContext off
    ├── replSession.ts             Drives the interactions view: init,
    │                              REPL multi-line buffer, file runs, exec chain
    ├── interactionsView.ts        WebviewView provider for the integrated
    │                              text + image stream + input row
    ├── level.ts                   #beginner / #intermediate / #advanced header parser
    ├── errorFormatter.ts          Plain-text rendering for diagnostic tooltips
    ├── diagnostics.ts             VS Code DiagnosticCollection (multi-finding)
    ├── pyodideRunner.ts           Bootstrap loader + types
    ├── deliverResult.ts           Translates Python results to ExecutionEvents
    ├── pyodideBootstrap.py        Real Python: run / repl-eval / tests / static analyzer
    ├── imageLib.py                Real Python: SVG image primitives + combinators
    ├── tableLib.py                Real Python: Table type + charts
    ├── analyzers/
    │   ├── types.ts               AnalysisFinding, RuntimeAnalyzer
    │   ├── nameErrorAnalyzer.ts   Runtime: NameError -> friendly finding
    │   ├── registry.ts            Runtime analyzer registry
    │   └── static/
    │       ├── shadowingExplainer.ts            shadowing + shadowing-builtin
    │       ├── reassignmentExplainer.ts         reassignment
    │       ├── disallowedKeywordExplainer.ts    `global` / `nonlocal`
    │       └── registry.ts                      Wraps Python-side raw findings
    └── errors/
        ├── pythonErrorParser.ts
        └── nameErrorExplainer.ts

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
new or different from that snapshot. PLL writes those back with
`workspace.fs.writeFile` so students can open `home_loans.csv` in the
explorer. `.py` files are mounted for `open` and for sibling imports
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
pnpm run smoke         # build, then static analyzer + explainers + images + tables + tests + pandas (incl. URL) + input() + workspace files + desktop worker parity
```

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
   `input.py` (interactive `input()`), `pandas.py` (`pd.read_csv`,
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

**Editor (Monaco) on vscode-web / `test-web`:** keyboard copy/paste is
**not supported** and is abandoned. What works:

- Editor **context menu** (right-click)
- Command Palette **PLL: Editor Copy/Cut/Paste** (`pll.editor.*`, via
  `vscode.env.clipboard`)

What does not: physical Ctrl/Cmd+C/X/V in the editor. vscode-web
**does not dispatch** those keys to commands so the browser can fire
`copy` / `paste` / `cut` without a permission prompt. Binding them
makes the workbench `preventDefault` and then **not** run the command
(palette still works). Leaving them unbound still does not give working
native copy here (`test-web` is Insiders with EditContext; COI also
restricts the clipboard). Do not bind `pll.editor.*` or
`editor.action.clipboard*Action` to those keys; activation strips
leftover `pll.editor.*` user bindings. PLL still turns EditContext off
(`editor.editContext`); that did not restore the keys.

`pnpm run test-web:clipboard` (Playwright `keyboard.press`) is **not**
a real OS keypress and is not evidence that copy works.

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
what the extension turns on. None of these write the user's
`settings.json`; a setting the user changes still wins.

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
`.py` file is opened. An extension cannot turn that product tip off on
every machine. For a course repo, add this to `.vscode/extensions.json`:

```json
{
  "unwantedRecommendations": [
    "ms-python.python",
    "ms-python.vscode-pylance"
  ]
}
```

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
