import type * as vscode from "vscode";
import type { Entry, InteractionsChange, InteractionsView, PanelState } from "./panel/view";
import type { ReplSession } from "./replSession";

/**
 * What PLL offers other extensions: `activate`'s return value, which they
 * read with `vscode.extensions.getExtension(PLL_ID)?.exports`. Assignment
 * Crits uses it to share the interactions panel with the panelists watching
 * a presentation. A change that isn't backwards-compatible gets a new
 * `version`, so a reader can tell what it has.
 */
export interface PllApi {
  readonly version: 1;
  readonly interactions: InteractionsApi;
}

/**
 * The interactions panel as its webview sees it: the session shown, and every
 * message that changes it (`panel/view.ts`).
 */
export interface InteractionsApi {
  /**
   * What the panel shows now: the session's file (its URI, or null for the
   * session with no file), its entries and its header and input row, and
   * whether the panel is on screen. The entries are PLL's own, and a
   * reactor's card changes in place as it plays: copy what is kept.
   */
  current(): InteractionsShown;
  /**
   * Each message the panel's webview is sent - `show` (a session from
   * scratch), `appendMany`, `reactorPatch`, `clear` and `state` - and each
   * change of whether the panel is visible.
   */
  readonly onDidChange: vscode.Event<InteractionsChange>;
}

export interface InteractionsShown {
  file: string | null;
  visible: boolean;
  entries: readonly Entry[];
  state: PanelState;
}

const NOTHING_SHOWN: PanelState = {
  title: "",
  prompt: "primary",
  status: null,
  awaitingInput: false,
  inputPrefix: "",
};

export function makeApi(view: InteractionsView, repl: ReplSession): PllApi {
  return {
    version: 1,
    interactions: {
      current: () => {
        const shown = repl.shown();
        return {
          file: shown?.file ?? null,
          visible: view.visible,
          entries: shown?.entries ?? [],
          state: shown?.state ?? NOTHING_SHOWN,
        };
      },
      onDidChange: view.onDidChange,
    },
  };
}
