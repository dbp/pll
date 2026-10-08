#!/usr/bin/env node
/**
 * Smoke test for input() + live display emit.
 *
 * Boots Pyodide in Node (no SAB / UI). Gives stdin through Pyodide's
 * `setStdin({ read })` from a queue of chunks - the same primitive the
 * worker uses, except the chunks are there at once instead of waited for.
 *
 * Also checks that `_pll_live_emit` fires once per stdout write so the
 * interactions view can show a prompt before input() waits.
 */

import { expect, passed } from "./lib/check.mjs";
import { bootPll } from "./lib/pyodide.mjs";

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
  const pyodide = await bootPll();

  const runFile = pyodide.globals.get("_pll_run_file");
  // Each entry is the next chunk of stdin: a line typed is that line and
  // its newline. Empty is the end of stdin.
  const lines = [];
  let stdinCalls = 0;
  let carry = new Uint8Array(0);
  pyodide.setStdin({
    read: (buffer) => {
      if (carry.length === 0) {
        stdinCalls += 1;
        const next = lines.shift();
        if (next === undefined) return 0;
        carry = typeof next === "string" ? new TextEncoder().encode(next) : next;
      }
      const n = Math.min(buffer.length, carry.length);
      buffer.set(carry.subarray(0, n));
      carry = carry.subarray(n);
      return n;
    },
  });

  console.log("\n[1] one input() call → one stdin read");
  {
    stdinCalls = 0;
    lines.length = 0;
    lines.push("Ada\n");
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

  console.log("\n[2] two input() calls → two stdin reads");
  {
    stdinCalls = 0;
    lines.length = 0;
    lines.push("1\n", "quit\n");
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
    lines.push("ok\n");
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

  console.log("\n[5] sys.stdin reads exactly what was given");
  {
    lines.length = 0;
    // No newline at the end, more than one buffer's worth, and a line that
    // is not the end of what was given.
    lines.push("x".repeat(20000) + "\nlast", "");
    const whole = call(runFile, ["import sys\ndata = sys.stdin.read()\nprint(len(data), repr(data[-6:]))\n", "all.py", "s5"]);
    expect(whole.stdout === "20005 'x\\nlast'\n", `all of it, and nothing added: ${JSON.stringify(whole.stdout)}`);
    lines.length = 0;
    lines.push(new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9, 0x0a]));
    const bytes = call(runFile, ["import sys\nprint(sys.stdin.buffer.read())\n", "bytes.py", "s5b"]);
    expect(bytes.stdout === "b'caf\\xc3\\xa9\\n'\n", `bytes as given: ${JSON.stringify(bytes.stdout)}`);
  }

  if (!passed()) {
    console.error("\ninput smoke failed");
    process.exit(1);
  }
  console.log("\ninput smoke passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
