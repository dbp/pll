#!/usr/bin/env node
/**
 * PLL's Python files - the bootstrap's and the libraries' - are all run into
 * one set of globals, so a name defined in two of them is defined once, by
 * whichever loads last, for both. Nothing would say so: the first file's
 * callers would just get the second file's function. This fails instead.
 *
 * The one repeat allowed is the same module imported under the same name,
 * which binds the same object either way.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPyodide } from "pyodide";
import { expect, passed } from "./lib/check.mjs";
import { ROOT } from "./lib/bundle.mjs";
import { INDEX_URL } from "./lib/pyodide.mjs";

const dirs = ["src/common", "src/common/bootstrap"];
const sources = dirs.flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(".py"))
    .map((name) => ({ file: `${dir}/${name}`, text: readFileSync(join(ROOT, dir, name), "utf8") })),
);

const pyodide = await loadPyodide({ indexURL: INDEX_URL });
pyodide.globals.set("sources_json", JSON.stringify(sources));
const report = pyodide.runPython(`
import ast, json
definitions = {}
for source in json.loads(sources_json):
    for node in ast.parse(source["text"]).body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".")[0]
                what = "import " + (node.module + "." if isinstance(node, ast.ImportFrom) and node.module else "") + alias.name
                definitions.setdefault(bound, []).append((source["file"], what))
            continue
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names = [node.name]
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and isinstance(node.target, ast.Name):
            names = [node.target.id]
        else:
            names = []
        for name in names:
            definitions.setdefault(name, []).append((source["file"], "definition"))
clashes = []
for name, places in definitions.items():
    files = sorted({f for f, _ in places})
    if len(files) < 2:
        continue
    kinds = {what for _, what in places}
    if len(kinds) == 1 and next(iter(kinds)).startswith("import "):
        continue  # the same module, under the same name
    clashes.append("%s: %s" % (name, ", ".join("%s (%s)" % p for p in places)))
json.dumps({"files": len(json.loads(sources_json)), "names": len(definitions), "clashes": clashes})
`);
const { files, names, clashes } = JSON.parse(report);

console.log(`\n[1] ${files} Python files, ${names} top-level names, one namespace`);
expect(files >= 13, `every file is checked: ${files}`);
expect(clashes.length === 0, `a name defined in more than one file:\n    ${clashes.join("\n    ")}`);

console.log(passed() ? "\nsmoke-python-sources: ok" : "\nsmoke-python-sources: FAILED");
process.exit(passed() ? 0 : 1);
