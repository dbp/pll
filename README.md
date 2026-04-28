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

## Architecture

```
src/
├── extension.ts            Desktop entrypoint (Node host)
├── web/extension.ts        Web entrypoint (vscode.dev)
├── web/pyodideWorker.ts    WebWorker that hosts Pyodide in the browser
├── web/pyodideRuntime.ts   Talks to the worker
├── desktop/pyodideRuntime.ts  Loads Pyodide directly in the Node host
└── common/
    ├── commands.ts         Start REPL + Run File commands (shared)
    ├── replSession.ts      Pseudoterminal-backed REPL (line editor + history)
    ├── ansi.ts             Tiny ANSI helpers
    ├── errorFormatter.ts   ANSI/plain renderers for friendly errors
    ├── diagnostics.ts      VS Code DiagnosticCollection
    ├── pyodideRunner.ts    Python source bootstrapped into Pyodide
    ├── analyzers/          Pluggable runtime + (future) static analyzers
    │   ├── types.ts
    │   ├── nameErrorAnalyzer.ts
    │   └── registry.ts
    └── errors/
        ├── pythonErrorParser.ts
        └── nameErrorExplainer.ts
```

The analyzer registry is the seam where future Flake8/Pylint-style static
checks (e.g. shadowing) will plug in - they'd run inside Pyodide via
`micropip` and produce the same `AnalysisFinding` objects.

## Development

```bash
pnpm install
pnpm run build      # one-shot build
pnpm run watch      # rebuild on change
```

To launch the desktop extension, open this folder in VS Code and press F5
(uses the standard "Extension Development Host" debug config). To test the
web extension:

```bash
pnpm run test-web
```

## Configuration

- `bonniePython.pyodideIndexUrl` - base URL for Pyodide assets (web only).
  Defaults to the matching pinned CDN build.
