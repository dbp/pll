import * as vscode from "vscode";

/**
 * Python Language Levels ships beginner-friendly defaults via `configurationDefaults`,
 * but some extensions emit Python diagnostics regardless of settings (most
 * notably `matangover.mypy`, which has no `enabled` or `ignorePatterns`
 * setting and is only quieted by disabling the extension itself).
 *
 * On activation we detect installed extensions known to conflict with the
 * beginner experience and offer a one-click action to open each one's
 * details page so the user can disable it in this workspace.
 */
interface KnownConflict {
  id: string;
  label: string;
  reason: string;
}

const CONFLICTING: KnownConflict[] = [
  {
    id: "ms-python.python",
    label: "Python (Microsoft)",
    reason: "installs Pylance, linting, and a second Run Python path",
  },
  {
    id: "ms-python.vscode-pylance",
    label: "Pylance",
    reason: "language-server completions and diagnostics",
  },
  {
    id: "matangover.mypy",
    label: "matangover.mypy",
    reason: "shows mypy diagnostics; no settings-based off switch",
  },
  {
    id: "ms-python.mypy-type-checker",
    label: "Microsoft Mypy Type Checker",
    reason: "shows mypy diagnostics",
  },
  {
    id: "ms-python.pylint",
    label: "Microsoft Pylint",
    reason: "shows pylint diagnostics",
  },
  {
    id: "ms-python.flake8",
    label: "Microsoft Flake8",
    reason: "shows flake8 diagnostics",
  },
  {
    id: "ms-python.bandit",
    label: "Microsoft Bandit",
    reason: "shows bandit diagnostics",
  },
  {
    id: "ms-pyright.pyright",
    label: "Pyright",
    reason: "shows type-check diagnostics + completions",
  },
  {
    id: "detachhead.basedpyright",
    label: "BasedPyright",
    reason: "shows type-check diagnostics + completions",
  },
  {
    id: "charliermarsh.ruff",
    label: "Ruff",
    reason: "shows lint diagnostics + completions",
  },
];

const DISMISSED_KEY = "pll.extensionGuard.dismissedIds";

export async function checkConflictingExtensions(
  context: vscode.ExtensionContext,
): Promise<void> {
  const dismissed = new Set<string>(
    context.workspaceState.get<string[]>(DISMISSED_KEY) ?? [],
  );
  const active = CONFLICTING.filter(
    (c) => !dismissed.has(c.id) && !!vscode.extensions.getExtension(c.id),
  );
  if (active.length === 0) {
    return;
  }

  const summary =
    active.length === 1
      ? `Python Language Levels: detected an installed extension that may emit Python diagnostics outside the beginner setup: ${active[0].label}.`
      : `Python Language Levels: detected ${active.length} installed extensions that may emit Python diagnostics outside the beginner setup: ${active
          .map((e) => e.label)
          .join(", ")}.`;

  const OPEN = "Show & Disable";
  const DISMISS = "Don't ask again";
  const choice = await vscode.window.showWarningMessage(summary, OPEN, DISMISS);

  if (choice === OPEN) {
    for (const ext of active) {
      try {
        await vscode.commands.executeCommand("extension.open", ext.id);
      } catch {
        // ignore – the extension might not expose this command in some hosts
      }
    }
    await vscode.window.showInformationMessage(
      'For each extension, click the gear icon and choose "Disable (Workspace)", then reload the window.',
      "Reload Window",
    ).then((c) => {
      if (c === "Reload Window") {
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
  } else if (choice === DISMISS) {
    const all = Array.from(new Set([...dismissed, ...active.map((e) => e.id)]));
    await context.workspaceState.update(DISMISSED_KEY, all);
  }
}
