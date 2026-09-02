#!/usr/bin/env node
/**
 * Integration smoke for the desktop worker: blocking input() via SAB
 * and pd.read_csv(url) through the Node XHR polyfill. Requires
 * `pnpm run build` so dist/desktop/pyodideWorker.js exists.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKER_PATH = resolve(ROOT, "dist", "desktop", "pyodideWorker.js");
const INDEX_URL = resolve(ROOT, "node_modules", "pyodide");

const STDIN_SAB_BYTES = 64 * 1024;
const STDIN_STATE_INDEX = 0;
const STDIN_LENGTH_INDEX = 1;
const STDIN_PAYLOAD_OFFSET = 8;
const STDIN_STATE_LINE = 1;
const STDIN_STATE_EOF = 2;

const CARS_CSV = "name,mpg\nvw,29\nhonda,33\nford,18\n";

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

function writeStdinLine(sab, line) {
  const state = new Int32Array(sab);
  if (line === null) {
    Atomics.store(state, STDIN_STATE_INDEX, STDIN_STATE_EOF);
    Atomics.notify(state, STDIN_STATE_INDEX);
    return;
  }
  const encoded = new TextEncoder().encode(line);
  const max = sab.byteLength - STDIN_PAYLOAD_OFFSET;
  const n = Math.min(encoded.length, max);
  new Uint8Array(sab, STDIN_PAYLOAD_OFFSET).set(encoded.subarray(0, n));
  Atomics.store(state, STDIN_LENGTH_INDEX, n);
  Atomics.store(state, STDIN_STATE_INDEX, STDIN_STATE_LINE);
  Atomics.notify(state, STDIN_STATE_INDEX);
}

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

function talk(worker, stdinLines) {
  let nextId = 1;
  const pending = new Map();
  const displays = [];
  let stdinCalls = 0;

  worker.on("message", (msg) => {
    if (msg.type === "display") {
      displays.push(msg.payload);
      return;
    }
    if (msg.type === "stdinRequest") {
      stdinCalls += 1;
      writeStdinLine(stdinLines.sab, stdinLines.queue.shift() ?? null);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) {
      return;
    }
    pending.delete(msg.id);
    if (msg.type === "error") {
      p.reject(new Error(msg.message));
    } else {
      p.resolve(msg);
    }
  });

  worker.on("error", (err) => {
    for (const p of pending.values()) {
      p.reject(err);
    }
    pending.clear();
  });

  return {
    displays,
    get stdinCalls() {
      return stdinCalls;
    },
    send(payload) {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      worker.postMessage({ id, ...payload });
      return promise;
    },
  };
}

async function main() {
  if (!existsSync(WORKER_PATH)) {
    console.error(`Missing ${WORKER_PATH}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }

  const sab = new SharedArrayBuffer(STDIN_SAB_BYTES);
  const stdinLines = { sab, queue: [] };
  const worker = new Worker(WORKER_PATH);
  const session = talk(worker, stdinLines);

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
  } finally {
    await worker.terminate();
  }

  console.log(`\nsmoke-desktop-parity: ${ok ? "ok" : "FAILED"}`);
  if (!ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
