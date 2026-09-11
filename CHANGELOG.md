# Changelog

## Unreleased

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
