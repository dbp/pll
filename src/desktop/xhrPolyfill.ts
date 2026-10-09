import { syncHttpRequest } from "./syncHttp";

/**
 * Browser globals Node needs so `pyodide-http` can patch urllib and
 * requests. That package imports `crossOriginIsolated` at load time
 * (missing → `patch_all()` silently does nothing) and then uses
 * `XMLHttpRequest.new(); open(..., false); send();`, reading `status`,
 * `response` / `responseText`, and `getAllResponseHeaders()`.
 *
 * PLL reads with `responseType = "arraybuffer"`, which gives the bytes as
 * they came (`_pll_fetch_bytes`, and the transport PLL gives pyodide-http).
 * Text is decoded as a browser decodes it: by the charset asked for with
 * `overrideMimeType`, else the response's own, else UTF-8.
 */

/** Text as XHR's `x-user-defined` gives it: 0x80-0xff become U+F780-U+F7FF. */
function decodeUserDefined(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...codes)` spreads into the argument list
  // and blows the stack somewhere around a hundred thousand bytes.
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const codes = Array.from(bytes.subarray(i, i + CHUNK), (b) => (b < 0x80 ? b : 0xf700 + b));
    out += String.fromCharCode(...codes);
  }
  return out;
}

function charsetOf(mime: string | null): string | null {
  const found = mime ? /;\s*charset=("?)([^";]+)\1/i.exec(mime) : null;
  return found ? found[2].trim().toLowerCase() : null;
}

function decodeText(bytes: Uint8Array, charset: string | null): string {
  if (charset === "x-user-defined") {
    return decodeUserDefined(bytes);
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function installNodeXHR(): void {
  const g = globalThis as Record<string, unknown>;
  // pyodide-http imports this at module load. Missing it makes
  // `patch_all()` a silent no-op. false keeps it on the XHR path
  // instead of trying to spawn a browser streaming Worker.
  if (typeof g.crossOriginIsolated === "undefined") {
    g.crossOriginIsolated = false;
  }
  if (typeof g.XMLHttpRequest === "function") {
    return;
  }

  class NodeXMLHttpRequest {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly HEADERS_RECEIVED = 2;
    static readonly LOADING = 3;
    static readonly DONE = 4;
    /** Says this is the desktop's, where a failed request is not about CORS. */
    static readonly pllNode = true;
    method = "GET";
    url = "";
    async = true;
    /** Milliseconds, as a browser's; 0 for the default limit. */
    timeout = 0;
    responseType = "";
    withCredentials = false;
    status = 0;
    statusText = "";
    response: ArrayBuffer | string | null = null;
    responseText = "";
    readyState = 0;
    /** The interrupt buffer, set by PLL's Python so a Stop ends the wait. */
    pllInterrupt: Uint8Array | null = null;
    private reqHeaders: Record<string, string> = {};
    private resHeaders: Record<string, string> = {};
    private mimeOverride: string | null = null;

    open(method: string, url: string, async = true): void {
      this.method = method;
      this.url = url;
      this.async = async;
      this.readyState = 1;
    }

    setRequestHeader(name: string, value: string): void {
      this.reqHeaders[name] = value;
    }

    overrideMimeType(mime: string): void {
      this.mimeOverride = mime;
    }

    send(body?: ArrayBuffer | Uint8Array | string | null): void {
      let payload: Uint8Array | string | null = null;
      if (body != null && body !== "") {
        if (typeof body === "string") {
          payload = body;
        } else if (body instanceof Uint8Array) {
          payload = body;
        } else if (body instanceof ArrayBuffer) {
          payload = new Uint8Array(body);
        }
      }
      const result = syncHttpRequest({
        method: this.method,
        url: this.url,
        headers: this.reqHeaders,
        body: payload,
        timeoutMs: this.timeout,
        interrupt: this.pllInterrupt,
      });
      this.status = result.status;
      this.statusText = result.status >= 200 && result.status < 300 ? "OK" : "";
      this.resHeaders = result.headers;
      this.readyState = 4;
      if (this.responseType === "arraybuffer") {
        const copy = new Uint8Array(result.body.byteLength);
        copy.set(result.body);
        this.response = copy.buffer;
        this.responseText = "";
      } else {
        const charset = charsetOf(this.mimeOverride) ?? charsetOf(this.getResponseHeader("content-type"));
        const text = decodeText(result.body, charset);
        this.response = text;
        this.responseText = text;
      }
    }

    getAllResponseHeaders(): string {
      return Object.entries(this.resHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
    }

    getResponseHeader(name: string): string | null {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(this.resHeaders)) {
        if (k.toLowerCase() === lower) {
          return v;
        }
      }
      return null;
    }
  }

  g.XMLHttpRequest = NodeXMLHttpRequest;
}
