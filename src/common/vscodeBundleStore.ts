import type * as vscode from "vscode";
import type { BundleStore, CachedBundle } from "./examplarSource";

const PREFIX = "examplar.bundle.";

/**
 * Cache bundles in the extension's global state.
 *
 * `globalState` rather than workspace state, because the same assignment
 * bundle is usually opened from several folders over a term, and rather
 * than files because it has to work identically on vscode.dev, where there
 * is no local disk.
 */
export function createMementoStore(memento: vscode.Memento): BundleStore {
  return {
    read(url) {
      return Promise.resolve(memento.get<CachedBundle>(PREFIX + url));
    },
    async write(url, entry) {
      await memento.update(PREFIX + url, entry);
    },
  };
}
