import { errorText } from "./errorText";

/**
 * The world half of `universe`: a client, never a server.
 *
 * Students write worlds, not servers, so PLL only needs to *connect*. That
 * is the whole reason this is feasible in both hosts - a browser worker
 * cannot listen for connections, but it can dial out. The server is an
 * ordinary process the course runs, in any language, speaking the protocol
 * below over WebSocket.
 *
 * Protocol: one JSON value per WebSocket text message, in both directions.
 * A message from the server is handed to `on_receive(state, message)`
 * unchanged; `package(state, message)` sends one back. That is all - there
 * is no handshake and no envelope, so a server is a dozen lines in any
 * language. It is deliberately *not* Racket's wire format, which is TCP and
 * s-expressions and unreachable from a browser.
 *
 * The socket lives on the extension host, next to the clock, so received
 * messages become just another event for the same reactor driver and the
 * Pyodide worker needs no networking at all.
 */

export interface UniverseSocket {
  /** Send one JSON-encoded message. */
  send(json: string): void;
  close(): void;
}

export interface UniverseHandlers {
  onOpen(): void;
  /** One JSON-encoded message from the server. */
  onMessage(json: string): void;
  onClose(reason: string): void;
  onError(message: string): void;
}

/**
 * Open a connection. Injected rather than imported by `ReplSession` so the
 * tests can hand it a fake; there is only one real implementation.
 */
export type UniverseConnect = (
  url: string,
  handlers: UniverseHandlers,
) => UniverseSocket;

export type UniverseStatus = "none" | "connecting" | "open" | "closed" | "error";

/**
 * What to tell the student when a connection fails and the platform will
 * not say why - which is the normal case, not an edge one. Browsers hide
 * the reason deliberately (it would leak information about the network),
 * and Node's global `WebSocket` raises a `TypeError` with an empty message
 * and no cause. Guessing usefully beats showing an empty string.
 */
export const UNIVERSE_CONNECT_HELP =
  "could not connect. Check the address, and that the server is running. " +
  "A page served over https (including vscode.dev) can only reach a wss:// " +
  "address, not ws:// - except on localhost.";

/** The platform's reason if it gave one, otherwise the help text above. */
export function universeErrorMessage(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text.length > 0 ? text : UNIVERSE_CONNECT_HELP;
}

/** Only `ws://` and `wss://` are connections; anything else is a typo. */
export function validateUniverseUrl(url: string): string | null {
  if (/^wss?:\/\/.+/.test(url)) {
    return null;
  }
  return `register must be a ws:// or wss:// address, got ${JSON.stringify(url)}`;
}

/**
 * The one implementation, shared by both hosts.
 *
 * `WebSocket` is a global in browser workers, and in Node from v22 - which
 * `engines.vscode` requires (VS Code 1.101, June 2025, was the first with
 * Node 22). Node's is undici's and fully spec-shaped: an `EventTarget` with
 * `onopen` / `onmessage` / `onclose` / `onerror` and close events carrying
 * `.code`. So there is nothing to branch on and no per-host adapter.
 */
export const connectUniverse: UniverseConnect = (url, handlers) => {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    return unavailableSocket(
      handlers,
      universeErrorMessage(errorText(err)),
    );
  }
  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (event: MessageEvent) => handlers.onMessage(String(event.data));
  socket.onclose = (event: CloseEvent) =>
    handlers.onClose(event.reason || `closed (code ${event.code})`);
  // Neither platform says *why*: browsers hide it deliberately, and Node
  // raises an `ErrorEvent` whose `message` is empty. Hence the help text.
  socket.onerror = () => handlers.onError(UNIVERSE_CONNECT_HELP);
  return {
    send: (json) => socket.send(json),
    close: () => socket.close(),
  };
};

/**
 * A socket that failed to open, so callers never deal with null. Reporting
 * happens through the same handler path as a real failure.
 */
export function unavailableSocket(
  handlers: UniverseHandlers,
  message: string,
): UniverseSocket {
  // Asynchronously, so the caller has finished wiring up before it hears.
  setTimeout(() => handlers.onError(message), 0);
  return { send: () => undefined, close: () => undefined };
}
