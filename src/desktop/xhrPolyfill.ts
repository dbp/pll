import { syncHttpRequest } from "./syncHttp";

/**
 * Browser globals Node needs so `pyodide-http` can patch urllib and
 * requests. That package imports `crossOriginIsolated` at load time
 * (missing → `patch_all()` silently does nothing) and then uses
 * `XMLHttpRequest.new(); open(..., false); send();`, reading `status`,
 * `response` / `responseText`, and `getAllResponseHeaders()`.
 *
 * When Pyodide is not in a *web* worker it treats `response` as a string
 * of ISO-8859-15 bytes; we decode the body as latin-1 to match.
 */
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
    method = "GET";
    url = "";
    async = true;
    timeout = 0;
    responseType = "";
    withCredentials = false;
    status = 0;
    statusText = "";
    response: ArrayBuffer | string | null = null;
    responseText = "";
    readyState = 0;
    private reqHeaders: Record<string, string> = {};
    private resHeaders: Record<string, string> = {};

    open(method: string, url: string, async = true): void {
      this.method = method;
      this.url = url;
      this.async = async;
      this.readyState = 1;
    }

    setRequestHeader(name: string, value: string): void {
      this.reqHeaders[name] = value;
    }

    overrideMimeType(_mime: string): void {
      /* pyodide-http calls this in the main-thread path; we ignore it. */
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
        const text = new TextDecoder("latin1").decode(result.body);
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
