#!/usr/bin/env node
/**
 * Smoke test for input() + live display emit.
 *
 * Boots Pyodide in Node (no SAB / UI). Uses Pyodide's setStdin with a
 * queue of lines and autoEOF:true — the same primitive the web worker
 * uses, except the callback returns immediately instead of blocking.
 *
 * Also checks that `_pll_live_emit` fires once per stdout write so the
 * interactions view can show a prompt before input() waits.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadPyodide } from "pyodide";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function readPy(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

function call(fn, args) {
  const proxy = fn(...args);
  if (proxy && typeof proxy === "object" && typeof proxy.toJs === "function") {
    const obj = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    return obj;
  }
  return proxy;
}

function stdoutTexts(result) {
  return (result.displays || [])
    .filter((d) => d.type === "stdout")
    .map((d) => d.text);
}

async function main() {
  const indexURL = resolve(ROOT, "node_modules", "pyodide");
  const pyodide = await loadPyodide({ indexURL });
  pyodide.runPython(readPy("src/common/pyodideBootstrap.py"));

  const runFile = pyodide.globals.get("_pll_run_file");
  const lines = ["Ada", "1"];
  let stdinCalls = 0;
  pyodide.setStdin({
    stdin: () => {
      stdinCalls += 1;
      return lines.shift() ?? null;
    },
    autoEOF: true,
  });

  console.log("\n[1] one input() call → one stdin callback (autoEOF:true)");
  {
    stdinCalls = 0;
    lines.length = 0;
    lines.push("Ada");
    const result = call(runFile, [
      'name = input("Name: ")\nprint("hi", name)\n',
      "input.py",
      "s1",
    ]);
    console.log(`    ok=${result.ok} stdinCalls=${stdinCalls} stdout=${JSON.stringify(result.stdout)}`);
    expect(result.ok === true, "program should succeed");
    expect(stdinCalls === 1, "expected 1 stdin call, got " + stdinCalls);
    expect(result.stdout === "Name: hi Ada\n", "stdout should be prompt + print, got " + JSON.stringify(result.stdout));
    const texts = stdoutTexts(result);
    expect(texts[0] === "Name: ", "first write should be the input prompt");
  }

  console.log("\n[2] two input() calls → two stdin callbacks");
  {
    stdinCalls = 0;
    lines.length = 0;
    lines.push("1", "quit");
    const result = call(runFile, [
      [
        "a = input('Choice: ')",
        "b = input('Again: ')",
        "print(a, b)",
      ].join("\n"),
      "menu.py",
      "s2",
    ]);
    console.log(`    ok=${result.ok} stdinCalls=${stdinCalls} stdout=${JSON.stringify(result.stdout)}`);
    expect(result.ok === true, "two-input program should succeed");
    expect(stdinCalls === 2, "expected 2 stdin calls, got " + stdinCalls);
    expect(
      result.stdout === "Choice: Again: 1 quit\n",
      "stdout should interleave both prompts then the print, got " + JSON.stringify(result.stdout),
    );
  }

  console.log("\n[3] live emit fires for each stdout write, including the prompt");
  {
    const emitted = [];
    pyodide.globals.set("_pll_live_emit", (json) => {
      emitted.push(JSON.parse(String(json)));
    });
    stdinCalls = 0;
    lines.length = 0;
    lines.push("ok");
    const result = call(runFile, [
      'x = input("Q: ")\nprint(x)\n',
      "live.py",
      "s3",
    ]);
    pyodide.runPython("_pll_live_emit = None");
    const liveStdout = emitted.filter((d) => d.type === "stdout").map((d) => d.text);
    const liveJoined = liveStdout.join("");
    console.log(`    live=${JSON.stringify(liveStdout)} resultStdout=${JSON.stringify(result.stdout)}`);
    expect(result.ok === true, "live-emit program should succeed");
    expect(liveStdout[0] === "Q: ", "live emit should include the prompt before input() returns");
    expect(liveJoined.includes("ok"), "live emit should include the print");
  }

  console.log("\n[4] EOF (null) → EOFError");
  {
    stdinCalls = 0;
    lines.length = 0;
    const result = call(runFile, ['input("x")\n', "eof.py", "s4"]);
    console.log(`    ok=${result.ok} error=${result.error_type}`);
    expect(result.ok === false, "EOF should fail the run");
    expect(result.error_type === "EOFError", "expected EOFError, got " + result.error_type);
  }

  if (!ok) {
    console.error("\ninput smoke failed");
    process.exit(1);
  }
  console.log("\ninput smoke passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
