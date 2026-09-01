# Changelog

## Unreleased

- Third-party packages now load automatically. When a file or prompt
  imports a library that Pyodide ships (for example **pandas** or
  **numpy**), PLL loads it before running, showing **Loading
  libraries...** while it fetches. This makes data-analysis programs
  that use `import pandas as pd` run without any extra setup.
- Reading data from a URL now works. When your code imports a networked
  library (pandas, `urllib`, `requests`, ...), PLL applies the
  `pyodide-http` shim so calls like
  `pd.read_csv("https://.../data.csv")` reach the network. This works in
  the browser (vscode.dev); on desktop VS Code, URL reads are not yet
  supported. The source must allow cross-origin requests (CORS).
- `input()` now works in the **web** extension (vscode.dev / `pnpm run
  test-web`). Prompts print in the interactions panel as the program
  runs, and you type the reply in the same input row. Desktop VS Code
  raises a clear error instead of hanging; blocking input there needs a
  worker thread that is not in place yet.

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
