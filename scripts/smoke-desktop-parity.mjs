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
const { STDIN_SAB_BYTES, writeStdinLine } = await importSource('export * from "./src/common/stdinBuffer";\n');

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
    onStdinRequest: () => writeStdinLine(sab, stdinLines.queue.shift() ?? null),
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
    const collectedNames = (collected.files ?? []).map((f) => f.name).sort();
    console.log(`    collected=${JSON.stringify(collectedNames)}`);
    expect(collectedNames.includes("home_loans.csv"), "new csv should be collected");
    expect(!collectedNames.includes("cars.csv"), "unchanged cars.csv should not be collected");
    expect(!collectedNames.includes("escape.csv"), "rejected path must not appear");
    const homeLoans = (collected.files ?? []).find((f) => f.name === "home_loans.csv");
    expect(
      homeLoans !== undefined && homeLoans.contents.includes("Dune,40"),
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
    const pandasFile = (pandasCollected.files ?? []).find((f) => f.name === "efficient_pandas.csv");
    expect(!!pandasFile, "to_csv should be collected from the desktop worker");
    expect(
      pandasFile !== undefined && pandasFile.contents.includes("honda"),
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
      // The real abort, which nothing can survive: the reply says so, so the
      // host can start a new Python rather than fail every run after this.
      const fatal = await run("import posix\nposix.abort()\n").then(
        () => null,
        (err) => err.reply,
      );
      expect(fatal?.kind === "finished", `a fatal error is marked finished: ${JSON.stringify(fatal)}`);
      console.log(`    os._exit and os.abort end the program; posix.abort -> ${fatal?.kind}`);
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
