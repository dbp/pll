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
├── web/pyodideWorker.ts           WebWorker that hosts Pyodide in the browser
├── web/pyodideRuntime.ts          Talks to the worker
├── desktop/pyodideRuntime.ts      Loads Pyodide directly in the Node host
└── common/
    ├── commands.ts                Run File / Show Interactions / Clear commands
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

## Development

```bash
pnpm install
pnpm run build         # one-shot build (also copies Pyodide assets into vendor/)
pnpm run watch         # rebuild on change
pnpm run vsce:package  # produce a .vsix (runs vscode:prepublish first)
pnpm run smoke         # static analyzer + explainers + image library/runtime + tests
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
   workers / SharedArrayBuffer features work, and points the workspace
   at `samples/` so you can open `hello.py` or `name_error.py`. First
   run downloads vscode-web into `.vscode-test-web/` (~30 MB) and
   Playwright Chromium into `~/Library/Caches/ms-playwright/` (~150 MB);
   both are cached afterward.

   Iteration tip: `pnpm run watch` in one terminal, `pnpm run test-web:server`
   in another, then reload the browser tab.

   `package.json` enables Playwright's postinstall via
   `pnpm.onlyBuiltDependencies`. If you cloned with `--ignore-scripts`,
   run `pnpm run setup:browser`.

3. **Real `vscode.dev`** with the published or sideloaded extension.

## Configuration

- `pll.pyodideIndexUrl` — base URL for Pyodide assets (web only).
  Defaults to the matching pinned CDN build.

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
