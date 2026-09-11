import typeguardWheel from "../../vendor/python/typeguard-4.6.0-py3-none-any.whl";
import typingExtensionsWheel from "../../vendor/python/typing_extensions-4.15.0-py3-none-any.whl";

/**
 * Pure-Python wheels bundled into the extension so runtime type checking
 * works with no network and no `micropip` step. esbuild's `base64` loader
 * inlines the bytes; the worker writes them into Pyodide's MEMFS and puts
 * them on `sys.path`, where zipimport reads them in place (a wheel is a
 * zip with the package at its root, so no unpacking is needed).
 *
 * `typing_extensions` is pinned to the version in Pyodide's own lockfile,
 * so a program that later pulls in Pyodide's copy (pandas depends on it)
 * sees the same code either way. These entries are *appended* to
 * `sys.path`, so a real package installed into site-packages still wins.
 */
export interface VendoredWheel {
  /** File name written into the vendored lib directory. */
  name: string;
  /** Base64-encoded wheel bytes. */
  base64: string;
}

/** Directory the wheels are written to inside Pyodide's MEMFS. */
export const PLL_VENDOR_DIR = "/pll_vendor";

/** Ordered so dependencies are importable before the packages that need them. */
export const VENDORED_WHEELS: ReadonlyArray<VendoredWheel> = [
  { name: "typing_extensions.whl", base64: typingExtensionsWheel },
  { name: "typeguard.whl", base64: typeguardWheel },
];
