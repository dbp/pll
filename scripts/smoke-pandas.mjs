#!/usr/bin/env node
/**
 * Packages and URLs: what a program imports is found and loaded the way
 * the worker does it, and URLs are read through the desktop's own network
 * path - its XMLHttpRequest polyfill, fetching on a helper thread, under
 * pyodide-http with PLL's transport (`http.py`).
 *
 * URL reads hit a local HTTP server, in a child process: this thread
 * blocks while it waits for an answer, so a server in it would never reply.
 */
import { spawn } from "node:child_process";

import { importSource } from "./lib/bundle.mjs";
import { expect, passed } from "./lib/check.mjs";
import { bootPll } from "./lib/pyodide.mjs";

const { installNodeXHR, PYODIDE_HTTP_PATCH_PY } = await importSource(
  'export { installNodeXHR } from "./src/desktop/xhrPolyfill";\n' +
    'export { PYODIDE_HTTP_PATCH_PY } from "./src/common/pythonSources";',
);

const CARS_CSV = "name,mpg\nvw,29\nhonda,33\nford,18\n";

/**
 * A server with a CSV in UTF-8 whose letters are among the eight bytes
 * Latin-1 and ISO-8859-15 disagree on, every byte value in a file, a 404,
 * and an address that never answers.
 */
function startServer() {
  return new Promise((resolveServer, reject) => {
    const script = `
const http = require("node:http");
const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const server = http.createServer((req, res) => {
  if (req.url === "/cars.csv") { res.writeHead(200, { "Content-Type": "text/csv" }); return res.end(${JSON.stringify(CARS_CSV)}); }
  if (req.url === "/cities.csv") { res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" }); return res.end("city,pop\\nZürich,400000\\n€ Šž Œœ Ÿ,1\\n"); }
  if (req.url === "/bytes") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(all); }
  if (req.url === "/hang") { return; }
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end("<!DOCTYPE html><html><body>Not Found</body></html>");
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));
`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      resolveServer({ base: `http://127.0.0.1:${Number(String(chunk).trim())}`, close: () => child.kill() });
    });
  });
}

async function main() {
  installNodeXHR();
  const pyodide = await bootPll();
  const py = (code) => pyodide.runPython(code);
  const found = (code, siblings = []) =>
    py(`_pll_package_imports(${JSON.stringify(code)}, ${JSON.stringify(JSON.stringify(siblings))})`).toJs({
      dict_converter: Object.fromEntries,
    });

  console.log("\n[1] every import is found, wherever it is written");
  {
    const helper = { name: "helper.py", text: "import pandas as pd\nimport requests\n" };
    const other = { name: "other_program.py", text: "import scipy\n" };
    const shapes = { name: "shapes/area.py", text: "import numpy\n" };
    const test = { name: "test.py", text: "def double(x):\n    return 2 * x\n" };
    const cases = [
      // An import in a module of theirs the program imports, and not in
      // another program beside it.
      ["import helper\n", [helper, other], ["pandas", "requests"], true],
      ["from shapes import area\n", [shapes], ["numpy"], false],
      // Not at the start of a line, and not first in its statement.
      ["x = 1; import numpy\n", [], ["numpy"], false],
      ["import numpy as np, urllib.request\n", [], ["numpy", "urllib"], true],
      ["def f():\n    import matplotlib.pyplot as plt\n", [], ["matplotlib"], false],
      // Named to importlib or __import__ in so many words.
      ['import importlib\nimportlib.import_module("micropip")\n', [], ["importlib", "micropip"], false],
      ['__import__("sympy")\n', [], ["sympy"], false],
      // Their own `test.py` is theirs, and CPython's tests are never loaded.
      ["import test\n", [test], [], false],
      ["import test\n", [], [], false],
    ];
    for (const [code, siblings, modules, network] of cases) {
      const got = found(code, siblings);
      expect(
        JSON.stringify(got.modules) === JSON.stringify(modules) && got.network === network,
        `${JSON.stringify(code)} with ${siblings.map((s) => s.name)}: wanted ${modules} (network ${network}), got ${JSON.stringify(got)}`,
      );
    }
    console.log(`    ${cases.length} kinds of import`);
  }

  console.log("\n[2] the packages found load, and the program runs");
  {
    const code = [
      "import pandas as pd",
      "import io",
      "df = pd.read_csv(io.StringIO('name,mpg\\nvw,29\\nhonda,33\\nford,18\\n'))",
      "(len(df), df[df['mpg'] >= 30]['name'].tolist())",
    ].join("\n");
    await pyodide.loadPackagesFromImports(found(code).modules.map((name) => `import ${name}`).join("\n"));
    const res = py(code).toJs();
    expect(res[0] === 3 && res[1].join(",") === "honda", `pandas ran: ${JSON.stringify(res)}`);
  }

  console.log("\n[3] an import that finds nothing says why");
  {
    await pyodide.loadPackage("pyodide-http");
    py(PYODIDE_HTTP_PATCH_PY.source);
    const why = (code) => {
      const result = py(`
try:
    exec(${JSON.stringify(code)}, {})
    _r = None
except ModuleNotFoundError as e:
    _pll_enrich_module_not_found(e)
    _r = (getattr(e, "_pll_facts", None) or {}).get("module")
_r`);
      return result?.toJs?.({ dict_converter: Object.fromEntries }) ?? result;
    };
    expect(why("import flask")?.kind === "missing", `flask: Pyodide has none: ${JSON.stringify(why("import flask"))}`);
    // Asked for and not loaded, as it would be offline.
    found("import micropip\n");
    expect(why("import micropip")?.kind === "notLoaded", `asked for, not loaded: ${JSON.stringify(why("import micropip"))}`);
    // Loaded by nothing, since no import PLL read named it.
    found("x = 1\n");
    const unseen = why('import importlib\nimportlib.import_module("micro" + "pip")');
    expect(unseen?.kind === "notSeen" && unseen?.package === "micropip", `named as it ran: ${JSON.stringify(unseen)}`);
    // A submodule of something that is there is Python's to explain.
    expect(why("import pandas.nonsense") === undefined, `a part of pandas: ${JSON.stringify(why("import pandas.nonsense"))}`);
  }

  console.log("\n[4] URLs through urllib, pandas and the libraries, on the desktop's path");
  const { base, close } = await startServer();
  try {
    const run = (code) => py(code).toJs({ dict_converter: Object.fromEntries });
    // Every byte value as sent: Latin-1 and ISO-8859-15 differ at eight.
    const bytes = run(`import urllib.request\nlist(urllib.request.urlopen(${JSON.stringify(base + "/bytes")}).read())`);
    expect(bytes.length === 256 && bytes.every((b, i) => b === i), `all 256 bytes: ${bytes.length}`);
    const cities = run(`urllib.request.urlopen(${JSON.stringify(base + "/cities.csv")}).read().decode("utf-8").splitlines()[1:]`);
    expect(cities.join("|") === "Zürich,400000|€ Šž Œœ Ÿ,1", `text as sent: ${JSON.stringify(cities)}`);
    const frame = run(`import pandas as pd\n(pd.read_csv(${JSON.stringify(base + "/cars.csv")}).name.tolist(), pd.read_csv(${JSON.stringify(base + "/cities.csv")}).city.tolist())`);
    expect(frame[0].join(",") === "vw,honda,ford" && frame[1][0] === "Zürich", `pandas reads them: ${JSON.stringify(frame)}`);
    // An error page is an error, not data.
    const notFound = run(`
import urllib.error
_out = []
for _read in (lambda: urllib.request.urlopen(${JSON.stringify(base + "/missing")}), lambda: pd.read_csv(${JSON.stringify(base + "/missing.csv")})):
    try:
        _read()
        _out.append("read")
    except urllib.error.HTTPError as e:
        _out.append(e.code)
_out`);
    expect(notFound.join(",") === "404,404", `404 raises, in urllib and pandas: ${notFound}`);
    // Unreachable, and too slow: urllib's own exceptions, in a sentence.
    const failed = run(`
import time
_out = []
for _url, _timeout in (("http://nowhere.invalid/x", None), (${JSON.stringify(base + "/hang")}, 0.5)):
    _start = time.time()
    try:
        urllib.request.urlopen(_url, timeout=_timeout) if _timeout else urllib.request.urlopen(_url)
    except urllib.error.URLError as e:
        _out.append([type(e.reason).__name__, str(e.reason), time.time() - _start < 5])
_out`);
    expect(
      failed[0]?.[1] === "could not connect to nowhere.invalid (ENOTFOUND)",
      `unreachable, said simply: ${JSON.stringify(failed[0])}`,
    );
    expect(
      failed[1]?.[0] === "TimeoutError" && /did not answer within 0\.5 seconds/.test(failed[1]?.[1]) && failed[1]?.[2] === true,
      `the timeout is kept: ${JSON.stringify(failed[1])}`,
    );
    // The libraries read the same way, and say what went wrong without
    // a word about CORS, which is a browser's.
    const libraries = run(`
_t = load_table(${JSON.stringify(base + "/cities.csv")})
try:
    load_table("http://nowhere.invalid/x.csv")
    _e = None
except OSError as e:
    _e = str(e)
[_t.column("city"), _e]`);
    expect(libraries[0][0] === "Zürich", `load_table: ${JSON.stringify(libraries[0])}`);
    expect(
      libraries[1] === "load_table could not read http://nowhere.invalid/x.csv: could not connect to nowhere.invalid (ENOTFOUND).",
      `no CORS advice off the web: ${libraries[1]}`,
    );
  } finally {
    close();
  }

  console.log(`\nsmoke-pandas: ${passed() ? "ok" : "FAILED"}`);
  if (!passed()) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
