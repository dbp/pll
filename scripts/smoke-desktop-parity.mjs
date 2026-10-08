#!/usr/bin/env node
/**
 * Integration smoke for the desktop worker: blocking input() via SAB
 * and pd.read_csv(url) through the Node XHR polyfill. Requires
 * `pnpm run build` so dist/desktop/pyodideWorker.js exists.
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, passed } from "./lib/check.mjs";
import { importSource, ROOT } from "./lib/bundle.mjs";
import { INDEX_URL } from "./lib/pyodide.mjs";
import { startWorker, talk } from "./lib/worker.mjs";

// The real layout, so the test cannot agree with itself and not the worker.
const { STDIN_SAB_BYTES, writeStdin } = await importSource('export * from "./src/common/stdinBuffer";\n');

const CARS_CSV = "name,mpg\nvw,29\nhonda,33\nford,18\n";

function startCsvServer() {
  return new Promise((resolveServer) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(CARS_CSV);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveServer({
        server,
        url: `http://127.0.0.1:${port}/cars.csv`,
      });
    });
  });
}

async function main() {

  const sab = new SharedArrayBuffer(STDIN_SAB_BYTES);
  const stdinLines = { queue: [] };
  const worker = startWorker();
  const session = talk(worker, {
    onStdinRequest: (request) => {
      const line = stdinLines.queue.shift();
      writeStdin(sab, request, line === undefined ? null : new TextEncoder().encode(line + "\n"));
    },
  });

  try {
    console.log("\n[1] desktop worker init");
    await session.send({
      type: "init",
      indexUrl: INDEX_URL,
      stdinBuffer: sab,
    });
    console.log("    ready");

    console.log("\n[2] input() via SharedArrayBuffer");
    stdinLines.queue.push("Ada");
    const inputReply = await session.send({
      type: "runFile",
      code: 'name = input("Name: ")\nprint("hi", name)\n',
      fileName: "input.py",
      sessionKey: "desktop-input",
    });
    const inputResult = inputReply.result;
    console.log(
      `    ok=${inputResult.ok} stdinCalls=${session.stdinCalls} stdout=${JSON.stringify(inputResult.stdout)}`,
    );
    expect(inputResult.ok === true, "input() program should succeed");
    expect(session.stdinCalls === 1, "expected 1 stdin call, got " + session.stdinCalls);
    expect(
      inputResult.stdout === "Name: hi Ada\n",
      "stdout should be prompt + print, got " + JSON.stringify(inputResult.stdout),
    );
    const livePrompt = session.displays.find((d) => d.type === "stdout" && d.text === "Name: ");
    expect(!!livePrompt, "live emit should include the input prompt");

    const { server, url } = await startCsvServer();
    try {
      console.log("\n[3] pd.read_csv(url) in the desktop worker");
      const urlCode = [
        "import pandas as pd",
        `df = pd.read_csv(${JSON.stringify(url)})`,
        "print(len(df), df[df['mpg'] >= 30]['name'].tolist())",
      ].join("\n");
      await session.send({ type: "loadPackages", code: urlCode });
      const urlReply = await session.send({
        type: "runFile",
        code: urlCode,
        fileName: "cars.py",
        sessionKey: "desktop-url",
      });
      const urlResult = urlReply.result;
      console.log(
        `    url=${url} ok=${urlResult.ok} stdout=${JSON.stringify(urlResult.stdout)} error=${urlResult.error_type || ""}`,
      );
      expect(urlResult.ok === true, "URL read should succeed: " + (urlResult.error_message || ""));
      expect(
        String(urlResult.stdout).includes("3") && String(urlResult.stdout).includes("honda"),
        "URL read stdout should include 3 and honda, got " + JSON.stringify(urlResult.stdout),
      );
    } finally {
      server.close();
    }

    console.log("\n[4] sibling files via mountWorkspace / collectWorkspace");
    await session.send({
      type: "mountWorkspace",
      files: [
        { name: "cars.csv", contents: CARS_CSV },
        { name: "../escape.csv", contents: "nope\n" },
      ],
    });
    const fileCode = [
      "with open('cars.csv') as f:",
      "    rows = f.readlines()",
      "print(len(rows) - 1)",
      "with open('home_loans.csv', 'w') as f:",
      "    f.write('title,days\\n')",
      "    f.write('Dune,40\\n')",
    ].join("\n");
    const fileReply = await session.send({
      type: "runFile",
      code: fileCode,
      fileName: "files.py",
      sessionKey: "desktop-files",
    });
    const fileResult = fileReply.result;
    console.log(
      `    ok=${fileResult.ok} stdout=${JSON.stringify(fileResult.stdout)} error=${fileResult.error_type || ""}`,
    );
    expect(fileResult.ok === true, "open() program should succeed: " + (fileResult.error_message || ""));
    expect(
      String(fileResult.stdout).includes("3"),
      "open() should print 3 data rows, got " + JSON.stringify(fileResult.stdout),
    );

    const collected = await session.send({ type: "collectWorkspace" });
    const collectedNames = collected.changes.files.map((f) => f.name).sort();
    console.log(`    collected=${JSON.stringify(collectedNames)}`);
    expect(collectedNames.includes("home_loans.csv"), "new csv should be collected");
    expect(!collectedNames.includes("cars.csv"), "unchanged cars.csv should not be collected");
    expect(!collectedNames.includes("escape.csv"), "rejected path must not appear");
    const homeLoans = collected.changes.files.find((f) => f.name === "home_loans.csv");
    expect(
      homeLoans !== undefined && new TextDecoder().decode(homeLoans.contents).includes("Dune,40"),
      "home_loans.csv should contain the written row",
    );

    const localPandas = [
      "import pandas as pd",
      "df = pd.read_csv('cars.csv')",
      "df[df['mpg'] >= 30].to_csv('efficient_pandas.csv', index=False)",
      "print(len(df))",
    ].join("\n");
    await session.send({ type: "loadPackages", code: localPandas });
    await session.send({
      type: "mountWorkspace",
      files: [{ name: "cars.csv", contents: CARS_CSV }],
    });
    const pandasReply = await session.send({
      type: "runFile",
      code: localPandas,
      fileName: "pandas_local.py",
      sessionKey: "desktop-pandas-local",
    });
    expect(
      pandasReply.result.ok === true,
      "local pd.read_csv should succeed: " + (pandasReply.result.error_message || ""),
    );
    const pandasCollected = await session.send({ type: "collectWorkspace" });
    const pandasFile = pandasCollected.changes.files.find((f) => f.name === "efficient_pandas.csv");
    expect(!!pandasFile, "to_csv should be collected from the desktop worker");
    expect(
      pandasFile !== undefined && new TextDecoder().decode(pandasFile.contents).includes("honda"),
      "efficient_pandas.csv should contain honda",
    );

    console.log("\n[5] a reactor handler's print reaches the host");
    {
      await session.send({
        type: "runFile",
        code: [
          "def tick(n):",
          '    print("tick", n)',
          "    return n + 1",
          "def draw(n):",
          '    return circle(5, "solid", "red")',
          "r = reactor(init=0, on_tick=tick, to_draw=draw)",
          "r.interact()",
        ].join("\n"),
        fileName: "rx.py",
        sessionKey: "desktop-reactor",
        level: "raw",
      });
      const id = session.displays.find((d) => d.type === "reactor")?.id;
      const before = session.displays.length;
      const step = await session.send({ type: "reactorStep", reactorId: id, event: '{"kind":"tick"}' });
      expect(step.result.ok === true, "the tick should succeed");
      const printed = session.displays
        .slice(before)
        .filter((d) => d.type === "stdout")
        .map((d) => d.text)
        .join("");
      expect(printed === "tick 0\n", `the handler's print is streamed: ${JSON.stringify(printed)}`);
      console.log(`    streamed ${JSON.stringify(printed)}`);
    }
    console.log("\n[6] an ended session's names are gone, and only its");
    {
      const define = (sessionKey) =>
        session.send({ type: "runFile", code: "kept = 41\n", fileName: "s.py", sessionKey, level: "raw" });
      const read = (sessionKey) =>
        session.send({ type: "replEval", code: "kept + 1", sessionKey, level: "raw" });
      await define("ends");
      await define("stays");
      expect((await read("ends")).result.result_repr === "42", "defined in the session to be ended");
      await session.send({ type: "endSession", sessionKey: "ends" });
      const after = (await read("ends")).result;
      expect(after.error_type === "NameError", `gone once it ends: ${after.error_type} ${after.result_repr}`);
      expect((await read("stays")).result.result_repr === "42", "another session's are untouched");
      console.log(`    after ending: ${after.error_type}`);
    }
    console.log("\n[9] a file's code runs as its own __main__, and at its own level");
    {
      const run = (code, sessionKey, level) =>
        session.send({ type: "runFile", code, fileName: `${sessionKey}.py`, sessionKey, level }).then((r) => r.result);
      // A beginner file's reactor, checked at beginner after another file
      // ran at advanced.
      const before = session.displays.length;
      await run([
        "def tick(n: int) -> int:",
        "    return n > 100",
        "def draw(n: int) -> Image:",
        '    return circle(5, "solid", "red")',
        "r = reactor(init=0, on_tick=tick, to_draw=draw)",
        "r.interact()",
      ].join("\n"), "lvA", "beginner");
      const id = session.displays.slice(before).find((d) => d.type === "reactor")?.id;
      const tick = async () =>
        (await session.send({ type: "reactorStep", reactorId: id, event: '{"kind":"tick"}' })).result.error_type;
      expect((await tick()) === "TypeCheckError", "a bool is not an int at beginner");
      await run("x = 1\n", "lvB", "advanced");
      expect((await tick()) === "TypeCheckError", "nor after another file ran at advanced");
      const advanced = await run("def f(n: int) -> int:\n    return n\nprint(f(True))\n", "lvC", "advanced");
      expect(advanced.stdout === "True\n", `at advanced it is: ${advanced.error_type}`);

      // What looks a class's module up finds the student's names.
      const own = await run([
        "from dataclasses import dataclass",
        "import sys, typing, __main__",
        "@dataclass",
        "class Node:",
        "    value: int",
        '    rest: "Node | None"',
        "print(typing.get_type_hints(Node)['rest'])",
        "print(__main__.Node is Node, sys.modules['__main__'].__dict__ is globals())",
        "print(any(n.startswith('_pll_run') for n in vars(__main__)))",
      ].join("\n"), "mainA", "raw");
      expect(own.stdout === "__main__.Node | None\nTrue True\nFalse\n", `the student's own module: ${JSON.stringify(own.stdout)} ${own.error_type}`);
      // A prompt line, and a reactor's handler, run as it too.
      const prompt = (await session.send({ type: "replEval", code: "import __main__\n__main__.Node is Node", sessionKey: "mainA", level: "raw" })).result;
      expect(prompt.result_repr === "True", `a prompt line runs as the file's __main__: ${prompt.result_repr} ${prompt.error_type}`);
      const mark = session.displays.length;
      await run([
        "import sys",
        "def tick(n):",
        "    # Looked up as the handler runs, not bound by the program's run.",
        '    return n + (1 if getattr(sys.modules["__main__"], "tick", None) is tick else 100)',
        "def draw(n):",
        '    return circle(5, "solid", "red")',
        "reactor(init=0, on_tick=tick, to_draw=draw).interact()",
      ].join("\n"), "mainC", "raw");
      const rid = session.displays.slice(mark).find((d) => d.type === "reactor")?.id;
      const stepped = (await session.send({ type: "reactorStep", reactorId: rid, event: '{"kind":"tick"}' })).result;
      expect(stepped.value_repr === "1", `a handler runs as its file's __main__: ${stepped.value_repr} ${stepped.error_type}`);

      // A name typing cannot resolve: the error is at the student's line,
      // not at line 1 of the string typing evaluated.
      const missing = await run(
        'import typing\nclass N:\n    x: "Missing"\nprint(typing.get_type_hints(N))\n',
        "mainB",
        "raw",
      );
      const users = (missing.error_frames ?? []).filter((f) => f.user).map((f) => `${f.file}:${f.line}`);
      expect(missing.error_type === "NameError" && users.join() === "mainB.py:4",
        `only the student's own frame is theirs: ${missing.error_type} ${users.join()}`);
      console.log("    its level, its __main__, and only its own frames");
    }
    console.log("\n[7] os._exit ends the program, not Python; a fatal error says Python is finished");
    {
      const run = (code, sessionKey = "exits") =>
        session.send({ type: "runFile", code, fileName: "x.py", sessionKey, level: "raw" });
      const exited = await run('import os\nprint("before")\nos._exit(0)\nprint("after")\n');
      expect(exited.result.ok && exited.result.stdout === "before\n", `the program ends there: ${JSON.stringify(exited.result.stdout)}`);
      const aborted = await run("import os\nos.abort()\n");
      expect(aborted.result.ok, "so does os.abort()");
      // The status reaches the host, and a message is shown, as Python shows it.
      const coded = await run("import sys\nsys.exit(3)\n");
      expect(coded.result.exit_code === 3, `the status is carried: ${coded.result.exit_code}`);
      const said = await run('import sys\nsys.exit("no data file")\n');
      expect(said.result.exit_code === 1 && said.result.stderr === "no data file\n",
        `a message is written to stderr: ${JSON.stringify(said.result.stderr)} ${said.result.exit_code}`);
      const finished = await run('print("done")\n');
      expect(finished.result.exit_code == null, `a program that just finishes has none: ${finished.result.exit_code}`);
      const after = await run('print("still here")\n', "another");
      expect(after.result.stdout === "still here\n", `and Python carries on: ${JSON.stringify(after.result.stdout)}`);
      // A real abort, in C, which nothing can survive: the reply says so, so
      // the host can start a new Python rather than fail every run after
      // this. (`os.abort` and `posix.abort` only end the program.)
      const fatal = await run("import faulthandler\nfaulthandler._sigabrt()\n").then(
        () => null,
        (err) => err.reply,
      );
      expect(fatal?.kind === "finished", `a fatal error is marked finished: ${JSON.stringify(fatal)}`);
      console.log(`    os._exit and os.abort end the program; a C abort -> ${fatal?.kind}`);
    }
  } finally {
    await worker.terminate();
  }

  console.log("\n[8] a Node worker that crashes is reported once, as Python lost");
  {
    const { DesktopPyodideRuntime, PythonLostError } = await importSource(`
export { DesktopPyodideRuntime } from "./src/desktop/pyodideRuntime";
export { PythonLostError } from "./src/common/runtimeErrors";
`);
    // A worker that starts, and then throws outside any request.
    const dir = mkdtempSync(join(ROOT, ".smoke-crash-"));
    const script = join(dir, "worker.cjs");
    writeFileSync(script, [
      'const { parentPort } = require("node:worker_threads");',
      "parentPort.on('message', (msg) => {",
      "  if (msg.type === 'init') parentPort.postMessage({ id: msg.id, type: 'ready' });",
      "  else setTimeout(() => { throw new Error('worker crashed'); }, 0);",
      "});",
    ].join("\n"));
    const runtime = new DesktopPyodideRuntime({
      indexUrlCandidates: [INDEX_URL],
      workerPath: script,
      missingAssetsHint: "no assets",
    });
    let told = 0;
    runtime.setPythonLostHandler(() => (told += 1));
    const quiet = console.error;
    console.error = () => {};
    let failure = null;
    try {
      await runtime.initialize();
      await runtime.replEval({ code: "1", sessionKey: "s" }, () => {}).catch((err) => (failure = err));
    } finally {
      console.error = quiet;
      runtime.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(failure instanceof PythonLostError, `the request fails as Python lost, not with the crash: ${failure}`);
    expect(told === 1, `and that is said once: ${told}`);
  }

  console.log(`\nsmoke-desktop-parity: ${passed() ? "ok" : "FAILED"}`);
  if (!passed()) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
