#!/usr/bin/env node
/**
 * The universe *client*, against a real WebSocket server.
 *
 * One implementation serves both hosts: `WebSocket` is a global in browser
 * workers and in Node from v22, which `engines.vscode` now requires.
 *
 * Students write worlds, not servers, so PLL only ever dials out - which is
 * what makes this feasible in a browser at all. The server here is
 * hand-rolled (handshake plus text frames, ~60 lines) rather than pulled
 * from a package, so the test has no dependency and doubles as a statement
 * of how small a conforming server is: one JSON value per text message, in
 * both directions, with no envelope and no handshake of our own.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { expect, passed } from "./lib/check.mjs";
import { importSource } from "./lib/bundle.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Encode one unmasked text frame (server -> client). */
function frame(text) {
  const body = Buffer.from(text, "utf8");
  const head =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : Buffer.concat([Buffer.from([0x81, 126]), (() => {
          const b = Buffer.alloc(2);
          b.writeUInt16BE(body.length);
          return b;
        })()]);
  return Buffer.concat([head, body]);
}

/** Pull complete masked text frames out of a buffer (client -> server). */
function drain(buffer, onText) {
  let buf = buffer;
  for (;;) {
    if (buf.length < 2) return buf;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return buf;
      len = buf.readUInt16BE(2);
      offset = 4;
    }
    const need = offset + (masked ? 4 : 0) + len;
    if (buf.length < need) return buf;
    const key = masked ? buf.subarray(offset, offset + 4) : null;
    const start = offset + (masked ? 4 : 0);
    const payload = Buffer.from(buf.subarray(start, start + len));
    if (key) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
    }
    if (opcode === 0x1) onText(payload.toString("utf8"));
    if (opcode === 0x8) onText(null); // close
    buf = buf.subarray(need);
  }
}

/** A server that echoes each message back with a counter added. */
function startServer() {
  const received = [];
  const sockets = [];
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.push(socket);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = drain(Buffer.concat([pending, chunk]), (text) => {
        if (text === null) return;
        received.push(text);
        socket.write(frame(JSON.stringify({ echo: JSON.parse(text), n: received.length })));
      });
    });
    socket.on("error", () => undefined);
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () =>
      res({
        server,
        received,
        url: `ws://127.0.0.1:${server.address().port}/`,
        push: (value) => sockets.forEach((s) => s.write(frame(JSON.stringify(value)))),
        hangUp: () => sockets.forEach((s) => s.destroy()),
      }),
    );
  });
}

async function loadTransport() {
  const mod = await importSource(`export {
  connectUniverse,
  validateUniverseUrl,
  UNIVERSE_CONNECT_HELP,
} from "./src/common/universeClient";
`);
  return mod;
}

/** Collect handler callbacks so a test can await the one it wants. */
function recorder() {
  const events = [];
  const waiters = [];
  const note = (kind, detail) => {
    events.push({ kind, detail });
    for (const w of [...waiters]) {
      if (w.kind === kind) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(detail);
      }
    }
  };
  return {
    events,
    handlers: {
      onOpen: () => note("open"),
      onMessage: (json) => note("message", json),
      onClose: (reason) => note("close", reason),
      onError: (message) => note("error", message),
    },
    wait(kind, ms = 8000) {
      const found = events.find((e) => e.kind === kind);
      if (found) return Promise.resolve(found.detail);
      return new Promise((resolve, reject) => {
        waiters.push({ kind, resolve });
        setTimeout(() => reject(new Error(`no ${kind} within ${ms}ms`)), ms);
      });
    },
  };
}

async function main() {
  const { connectUniverse, validateUniverseUrl, UNIVERSE_CONNECT_HELP } =
    await loadTransport();

  console.log("\n[1] addresses are checked before dialling");
  expect(validateUniverseUrl("ws://localhost:8080") === null, "ws:// is valid");
  expect(validateUniverseUrl("wss://example.com/x") === null, "wss:// is valid");
  expect(validateUniverseUrl("http://localhost") !== null, "http:// is rejected");
  expect(validateUniverseUrl("localhost:8080") !== null, "a bare host is rejected");
  console.log("    ok");

  const srv = await startServer();
  console.log(`\n[2] connect to a real server at ${srv.url}`);
  const rec = recorder();
  const socket = connectUniverse(srv.url, rec.handlers);
  await rec.wait("open");
  console.log("    open");

  console.log("\n[3] send a message and get the reply");
  socket.send(JSON.stringify({ move: "left" }));
  const reply = JSON.parse(await rec.wait("message"));
  console.log(`    server said ${JSON.stringify(reply)}`);
  expect(reply.echo.move === "left", "the server should see what was sent");
  expect(srv.received.length === 1, "the server should have received exactly one message");

  console.log("\n[4] a server-initiated message arrives too");
  const rec2 = recorder();
  const socket2 = connectUniverse(srv.url, rec2.handlers);
  await rec2.wait("open");
  srv.push({ tick: 42 });
  const pushed = JSON.parse(await rec2.wait("message"));
  expect(pushed.tick === 42, `expected the pushed message, got ${JSON.stringify(pushed)}`);
  console.log("    ok");

  console.log("\n[5] a payload over 125 bytes still round-trips");
  const big = { text: "x".repeat(400) };
  socket.send(JSON.stringify(big));
  let long = null;
  for (let i = 0; i < 40 && long === null; i++) {
    const m = rec.events.filter((e) => e.kind === "message").map((e) => JSON.parse(e.detail));
    long = m.find((v) => v.echo && v.echo.text && v.echo.text.length === 400) ?? null;
    if (long === null) await new Promise((r) => setTimeout(r, 100));
  }
  expect(long !== null, "a multi-byte-length frame should round-trip");
  console.log("    ok");

  console.log("\n[6] losing the server is reported, not silent");
  srv.hangUp();
  const why = await Promise.race([
    rec.wait("close", 8000).then((d) => ({ kind: "close", d })),
    rec.wait("error", 8000).then((d) => ({ kind: "error", d })),
  ]);
  console.log(`    ${why.kind}: ${why.d}`);
  expect(why.kind === "close" || why.kind === "error", "a dropped server should notify");

  console.log("\n[7] an address nobody is listening on fails cleanly");
  const rec3 = recorder();
  connectUniverse("ws://127.0.0.1:1/", rec3.handlers);
  const failure = await Promise.race([
    rec3.wait("error", 8000).then((d) => ({ kind: "error", d })),
    rec3.wait("close", 8000).then((d) => ({ kind: "close", d })),
  ]);
  console.log(`    ${failure.kind}: ${failure.d}`);
  expect(!rec3.events.some((e) => e.kind === "open"), "it must not report open");
  // Node reports nothing useful here, so the message has to come from us -
  // an empty reason in the panel would be worse than no message at all.
  expect(
    typeof failure.d === "string" && failure.d.trim().length > 20,
    `the failure should explain itself, got ${JSON.stringify(failure.d)}`,
  );
  if (failure.kind === "error") {
    expect(failure.d === UNIVERSE_CONNECT_HELP, "it should be the shared help text");
  }

  socket.close();
  socket2.close();
  srv.server.close();

  if (!passed()) {
    console.error("\nsmoke-universe: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-universe: ok");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
