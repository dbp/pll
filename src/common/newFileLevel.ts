import * as vscode from "vscode";
import type { Level } from "./level";

/**
 * Seed newly created `.py` files with a `#level` header.
 *
 * This is a *template*, not a second source of truth. The level still lives
 * in the file, visibly, on the first line - so the same file behaves the
 * same way on every machine. A setting that changed what a *headerless*
 * file means would be a different and much worse thing: two students could
 * run identical code and get different answers, which is exactly what
 * having one in-file level is meant to prevent.
 *
 * A course sets this in the handout's `.vscode/settings.json`, so students'
 * new files start at the level the course is teaching.
 */

/** `none` writes nothing; anything else is the level to write. */
export type NewFileLevel = Level | "none";

function configuredLevel(): NewFileLevel {
  const value = vscode.workspace
    .getConfiguration("pll")
    .get<string>("newFileLevel", "none");
  switch (value) {
    case "raw":
    case "beginner":
    case "intermediate":
    case "advanced":
      return value;
    default:
      return "none";
  }
}

/** The exact text written into a new file. */
export function headerFor(level: Level): string {
  return `#level ${level}\n\n`;
}

/**
 * Only ever seed a file with nothing in it. A `.py` that arrives with
 * content was copied, generated, or restored, and prepending to it would be
 * an edit the user did not ask for.
 */
async function isBlank(uri: vscode.Uri): Promise<boolean> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.length === 0) return true;
    return new TextDecoder().decode(bytes).trim().length === 0;
  } catch {
    return false;
  }
}

async function seed(uri: vscode.Uri, level: Level): Promise<void> {
  if (!uri.path.endsWith(".py")) return;
  if (!(await isBlank(uri))) return;
  try {
    await vscode.workspace.fs.writeFile(
      uri,
      new TextEncoder().encode(headerFor(level)),
    );
  } catch {
    /* the file vanished or is read-only; nothing worth interrupting for */
  }
}

/**
 * Watch for created files. Read per event, so changing the setting takes
 * effect without a reload.
 */
export function registerNewFileLevel(): vscode.Disposable {
  return vscode.workspace.onDidCreateFiles((event) => {
    const level = configuredLevel();
    if (level === "none") return;
    for (const uri of event.files) {
      void seed(uri, level);
    }
  });
}
