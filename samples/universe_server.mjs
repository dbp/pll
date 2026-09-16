#!/usr/bin/env node
/**
 * A reference universe server for PLL worlds. Dependency-free, so you can
 * copy this file anywhere and run it:
 *
 *     node universe_server.mjs            # listens on 8080
 *     PORT=9000 node universe_server.mjs
 *
 * The protocol is deliberately tiny: one JSON value per WebSocket text
 * message, in each direction. Whatever a world sends with `package(...)`
 * arrives here; whatever this sends is handed to that world's
 * `on_receive(state, message)`. There is no envelope and no handshake, so a
 * server in any language is about this long.
 *
 * This one relays: every message is forwarded to all the *other* worlds,
 * tagged with who sent it. Replace `handle` to keep server-side state.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8080);
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const worlds = new Map(); // socket -> name
let counter = 0;

/** Encode one unmasked text frame. */
function frame(text) {
  const body = Buffer.from(text, "utf8");
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  if (body.length < 65536) {
    const head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([head, body]);
}

/** Pull complete frames out of `buf`; returns the unconsumed remainder. */
function drain(buf, onText, onClose) {
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
    } else if (len === 127) {
      if (buf.length < 10) return buf;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const need = offset + (masked ? 4 : 0) + len;
    if (buf.length < need) return buf;
    const key = masked ? buf.subarray(offset, offset + 4) : null;
    const payload = Buffer.from(buf.subarray(offset + (masked ? 4 : 0), need));
    if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
    if (opcode === 0x1) onText(payload.toString("utf8"));
    if (opcode === 0x8) onClose();
    buf = buf.subarray(need);
  }
}

function send(socket, value) {
  try {
    socket.write(frame(JSON.stringify(value)));
  } catch {
    /* the world went away mid-write */
  }
}

/** Replace this to do something other than relay. */
function handle(from, message) {
  for (const [socket, name] of worlds) {
    if (socket !== from) {
      send(socket, { from: worlds.get(from), message });
    }
  }
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`PLL universe server. ${worlds.size} world(s) connected.\n`);
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Accept: " +
      createHash("sha1").update(key + GUID).digest("base64") +
      "\r\n\r\n",
  );
  const name = `world-${++counter}`;
  worlds.set(socket, name);
  console.log(`+ ${name} connected (${worlds.size} total)`);
  send(socket, { welcome: name });

  let pending = Buffer.alloc(0);
  const bye = () => {
    if (!worlds.has(socket)) return;
    console.log(`- ${worlds.get(socket)} left`);
    worlds.delete(socket);
    socket.destroy();
  };
  socket.on("data", (chunk) => {
    pending = drain(
      Buffer.concat([pending, chunk]),
      (text) => {
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          console.log(`  ${name} sent something that is not JSON; ignoring`);
          return;
        }
        console.log(`  ${name}: ${text}`);
        handle(socket, value);
      },
      bye,
    );
  });
  socket.on("close", bye);
  socket.on("error", bye);
});

server.listen(PORT, () =>
  console.log(`PLL universe server listening on ws://localhost:${PORT}`),
);
