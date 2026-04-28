# Bonnie Python

A beginner-friendly Python extension for VS Code, powered by [Pyodide](https://pyodide.org).
It works in **desktop VS Code** and in **`vscode.dev`** (web).

## Features (MVP)

- **Persistent REPL** via `Bonnie Python: Start REPL`. Opens a real
  pseudoterminal (works in desktop and `vscode.dev`) with multi-line block
  support, history navigation (Up/Down arrows), and Ctrl+C to clear input.
  Multi-line completeness is decided by the same `codeop.compile_command`
  Python's own interactive shell uses.
- **Run Python files into the REPL.** `Bonnie Python: Run Active File`
  (also available from the editor title run button on `.py` files) runs
  the file *inside* the REPL, so any names it defines stay available for
  the next prompt.
- **Beginner-friendly errors.** Currently `NameError` is rewritten to a
  plain-language explanation with a "what / why / how to fix" breakdown,
  shown in the REPL terminal (with ANSI colors) and as an editor diagnostic
  on the offending line/identifier.
- **Language levels** (`#beginner` / `#expert`). The first non-blank line of
  a file may be a magic comment that selects a language level. At
  `#beginner`, files are statically checked for **variable shadowing**
  (including built-ins) and **variable reassignment**; if any check fires,
  the file isn't executed and findings are surfaced in the REPL and editor.
  `#expert` (the default if no header is present) disables all static checks
  and runs the file as plain Python. The REPL itself is always expert.

## Architecture

```
src/
├── extension.ts                   Desktop entrypoint (Node host)
├── web/extension.ts               Web entrypoint (vscode.dev)
├── web/pyodideWorker.ts           WebWorker that hosts Pyodide in the browser
├── web/pyodideRuntime.ts          Talks to the worker
├── desktop/pyodideRuntime.ts      Loads Pyodide directly in the Node host
└── common/
    ├── commands.ts                Start REPL + Run File commands (shared)
    ├── replSession.ts             Pseudoterminal-backed REPL (line editor + history)
    ├── level.ts                   #beginner / #expert header parser
    ├── ansi.ts                    Tiny ANSI helpers
    ├── errorFormatter.ts          ANSI/plain renderers for friendly errors
    ├── diagnostics.ts             VS Code DiagnosticCollection (multi-finding)
    ├── pyodideRunner.ts           Bootstrap loader + types
    ├── pyodideBootstrap.py        Real Python: run / repl-eval / static analyzer
    ├── analyzers/
    │   ├── types.ts               AnalysisFinding, RuntimeAnalyzer
    │   ├── nameErrorAnalyzer.ts   Runtime: NameError -> friendly finding
    │   ├── registry.ts            Runtime analyzer registry
    │   └── static/
    │       ├── shadowingExplainer.ts     shadowing + shadowing-builtin
    │       ├── reassignmentExplainer.ts  reassignment
    │       └── registry.ts               Wraps Python-side raw findings
    └── errors/
        ├── pythonErrorParser.ts
        └── nameErrorExplainer.ts
```

The static analyzer itself (scope builder, shadowing/reassignment checks)
lives in `pyodideBootstrap.py`. esbuild's `text` loader inlines that file as
a string at build time so it's loaded into Pyodide once on init - which means
the analysis runs in the same Python interpreter that runs the user's code,
in both desktop and web hosts.

## Smoke tests

```bash
pnpm run smoke   # static-analyzer Python tests + TS explainer/format tests
```

## Development

```bash
pnpm install
pnpm run build      # one-shot build
pnpm run watch      # rebuild on change
```

### Running the desktop extension

Open this folder in VS Code and press **F5** -> *Run Extension (Desktop)*.
A second window opens with the extension loaded.

### Running the web extension (the primary target)

There are three options, in increasing order of "how realistic":

1. **F5 -> *Run Extension (Web)*** in desktop VS Code. Uses
   `extensionDevelopmentKind=web` so the extension host runs the web
   bundle (`dist/web/extension.js`) and a real `Worker`. This is the
   fastest iteration loop because it gives you the full debugger.

2. **`pnpm run test-web`** spins up a local copy of `vscode-web` (the
   exact build behind `vscode.dev`) and opens it in Chromium with our
   extension preloaded. Closest thing to `vscode.dev` short of actually
   publishing.

   ```bash
   pnpm run test-web              # ensures Chromium is downloaded, builds,
                                  # then opens vscode-web in Chromium
   pnpm run test-web:server       # build + run server on :3000 only
                                  # (browse to it from any browser)
   pnpm run setup:browser         # one-time: download Playwright Chromium
                                  # (chained from test-web; safe to run alone)
   ```

   The script enables `--coi` (cross-origin isolation) so Pyodide's
   workers/SharedArrayBuffer features work, and points the workspace at
   `samples/` so you can immediately open `hello.py` or `name_error.py`.
   First run downloads vscode-web into `.vscode-test-web/` (~30 MB) and
   Playwright Chromium into `~/Library/Caches/ms-playwright/` (~150 MB);
   both are cached for subsequent runs.

   Iteration tip: in one terminal run `pnpm run watch` so esbuild
   rebuilds on save; in another run `pnpm run test-web:server` and just
   reload the browser tab to pick up changes.

   `package.json` enables Playwright's postinstall via
   `pnpm.onlyBuiltDependencies` so a fresh `pnpm install` fetches
   Chromium for you. If you ever skipped it (e.g. cloned with
   `--ignore-scripts`), `pnpm run setup:browser` re-runs that step.

3. **Real `vscode.dev`** with the published or sideloaded extension.
   This is what end users hit; only useful once you're ready to publish.

## Configuration

- `bonniePython.pyodideIndexUrl` - base URL for Pyodide assets (web only).
  Defaults to the matching pinned CDN build.

## Beginner-friendly editor lockdown

This extension ships **opinionated `configurationDefaults`** that quiet down
the default Python editing experience so beginners only see what we
explicitly turn on. None of these touch your `settings.json`; they are
defaults the extension contributes, so any setting you change yourself
still wins.

What stays on by design:

- Syntax highlighting (built-in TextMate grammar)
- Line numbers, bracket matching, indent guides
- Auto-closing brackets / quotes (helpful for newcomers)
- The Problems panel (so our friendly errors show up)
- Our REPL terminal and `Run Active File` button

What we turn off for `[python]` files:

- All autocomplete popups: `editor.quickSuggestions`,
  `suggestOnTriggerCharacters`, `tabCompletion`, `wordBasedSuggestions`,
  `parameterHints`, `snippetSuggestions`, `suggest.showWords/showSnippets`
- Inline AI suggestions: `editor.inlineSuggest.enabled`,
  `github.copilot.enable.python`, `github.copilot.editor.enableAutoCompletions`,
  `cursor.cpp.disabledLanguages` (Cursor Tab) - best-effort across forks
- CodeLens, lightbulb (quick-fix), minimap, sticky scroll, linked editing
- Format on save / paste / type

What we turn off globally (no-ops if the extension isn't installed):

- Microsoft Python extension legacy linting:
  `python.linting.{enabled,pylintEnabled,flake8Enabled,mypyEnabled,banditEnabled,pycodestyleEnabled,pydocstyleEnabled}`
- Pylance: `python.languageServer = None`,
  `python.analysis.{autoImportCompletions,typeCheckingMode,completeFunctionParens,indexing,useLibraryCodeForTypes,diagnosticMode}`
- Standalone linters/formatters - we silence them via the python-tools
  template's `ignorePatterns: ["**"]` (which matches every absolute path):
  `pylint.{enabled,ignorePatterns}`, `flake8.{enabled,ignorePatterns}`,
  `bandit.{enabled,ignorePatterns}`,
  `mypy-type-checker.{enabled,ignorePatterns,reportingScope}`,
  `ruff.{enable,lint.enable,ignorePatterns}`
- `matangover.mypy` (no settings-based off switch) -
  `mypy.runUsingActiveInterpreter`, `mypy.checkNotebookFiles`,
  `mypy.checkAllOpenFolders`, `mypy.targets: []`. **This still triggers on
  save** for the active file - see "Extension guard" below.
- Pyright family: `pyright.disableLanguageServices` +
  `pyright.disableOrganizeImports`, plus the same pair for `basedpyright`
- Formatters: `black-formatter.formatOnSave`, `isort.formatOnSave`
- Other noise: `python.terminal.activateEnvironment`,
  `python.experiments.enabled`, `python.showStartPage`,
  `breadcrumbs.enabled`

### Extension guard (auto-prompt on activation)

Some Python extensions emit diagnostics regardless of settings - the most
notorious is **`matangover.mypy`**, which has no `enabled` and no
`ignorePatterns` setting; the only way to silence it is to disable the
extension itself.

To handle this, `[src/common/extensionGuard.ts](src/common/extensionGuard.ts)`
runs on activation: it scans installed extensions, lists known
beginner-conflicting ones (`matangover.mypy`,
`ms-python.{mypy-type-checker,pylint,flake8,bandit}`,
`ms-pyright.pyright`, `detachhead.basedpyright`, `charliermarsh.ruff`),
and shows a single warning notification with two buttons:

- **Show & Disable** opens each conflicting extension's details page so
  you can click *Disable (Workspace)* on each, then offers to reload.
- **Don't ask again** records dismissal in the workspace state so the
  prompt won't reappear in this workspace.

### Things you may still need to disable manually

Some features are owned by other tools that ignore both VS Code's
`configurationDefaults` and our extension-detector. If they appear in
your editor and you want a fully clean beginner experience, disable them
by hand:

- Cursor's "Tab" autocomplete: in addition to the
  `cursor.cpp.disabledLanguages` hint above, you may need to toggle
  Cursor's AI features in **Cursor Settings -> Features -> Tab**.
- Any other AI assistant extension (Codeium, Tabnine, Supermaven, ...) -
  disable per-language or per-workspace in that extension's own settings.
- Workspace-installed extensions you don't want active here: use
  **"Extensions: Disable (Workspace)"** from the command palette.

If a setting we ship isn't aggressive enough for your classroom, override
it in your workspace `.vscode/settings.json` - your value always wins
over our defaults.
