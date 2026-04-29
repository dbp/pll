// Bonnie interactions view client.
//
// Lives inside the WebviewView. Holds the currently-displayed session's
// entry log + an input row, and talks to the extension host via postMessage.
// The session manager on the host owns per-file session state; we just
// mirror whatever's "currently shown" via vscode.setState so we restore
// fast on webview reload.
//
// Host -> view messages:
//   { type: "append", entry }                - append to current session
//   { type: "clear" }                        - clear current session entries
//   { type: "prompt", kind }                 - change prompt for current
//   { type: "busy", busy, status? }          - busy state for current
//   { type: "replay", mode: "session", title, entries, prompt, busy, status? }
//                                            - swap to a different session
//   { type: "empty", message }               - no session active
//   { type: "title", title }                 - update header title in place
//   { type: "focusInput" }
//
// View -> host messages:
//   { type: "ready" }
//   { type: "submit", code }
//   { type: "interrupt" }
//   { type: "clearRequested" }
//   { type: "openLocation", fileName, line, column? }
//   { type: "saveSvg", svg, source? }

(function () {
  const vscode = acquireVsCodeApi();

  /** @type {{ mode: "session" | "empty", emptyMessage: string, title: string, entries: any[], prompt: "primary" | "continuation", busy: boolean, history: string[] }} */
  const state = vscode.getState() ?? {
    mode: "empty",
    emptyMessage: "Open a Python file to start an interactions session.",
    title: "",
    entries: [],
    prompt: "primary",
    busy: false,
    history: [],
  };

  const body = document.body;
  const titleEl = document.getElementById("title");
  const stream = document.getElementById("stream");
  const empty = document.getElementById("empty");
  const inputRow = document.getElementById("inputRow");
  const promptEl = document.getElementById("prompt");
  const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById("input"));
  const statusEl = document.getElementById("status");
  const clearBtn = document.getElementById("clear");

  let historyIdx = -1;
  /** Buffer of the user's draft when they start scrolling history. */
  let historyDraft = "";
  /** Track whether the stream is scrolled (close to) the bottom; if so, auto-scroll. */
  let stickToBottom = true;

  function persist() {
    vscode.setState(state);
  }

  function applyMode() {
    body.classList.toggle("mode-empty", state.mode === "empty");
    body.classList.toggle("mode-session", state.mode === "session");
  }

  function applyTitle() {
    titleEl.textContent = state.title || "";
  }

  function setPromptText() {
    promptEl.textContent = state.prompt === "continuation" ? "..." : ">>>";
  }

  function setBusy(busy, status) {
    state.busy = busy;
    inputRow.classList.toggle("busy", busy);
    textarea.disabled = busy;
    statusEl.textContent = busy ? (status || "Running...") : "";
    if (!busy && state.mode === "session") {
      requestAnimationFrame(() => textarea.focus());
    }
    persist();
  }

  function clearStream() {
    state.entries = [];
    persist();
    renderAll();
  }

  /** Default empty-stream caption for an active session that has no entries yet. */
  const SESSION_EMPTY_TEXT =
    "Run the file or evaluate an expression at the prompt below.";

  function renderEmpty() {
    empty.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = state.mode === "empty"
      ? state.emptyMessage
      : SESSION_EMPTY_TEXT;
    empty.appendChild(span);
  }

  function renderAll() {
    stream.innerHTML = "";
    if (state.entries.length === 0) {
      renderEmpty();
      stream.appendChild(empty);
      return;
    }
    if (empty.parentNode) empty.parentNode.removeChild(empty);
    for (const entry of state.entries) {
      stream.appendChild(buildEntryNode(entry));
    }
    scrollToBottom();
  }

  function appendEntry(entry) {
    state.entries.push(entry);
    persist();
    if (empty.parentNode) empty.parentNode.removeChild(empty);
    stream.appendChild(buildEntryNode(entry));
    if (stickToBottom) scrollToBottom();
  }

  function scrollToBottom() {
    stream.scrollTop = stream.scrollHeight;
  }

  function buildEntryNode(entry) {
    switch (entry.kind) {
      case "banner":      return renderBanner(entry);
      case "echo":        return renderEcho(entry);
      case "stdout":      return renderText(entry, "stdout");
      case "stderr":      return renderText(entry, "stderr");
      case "result":      return renderResult(entry);
      case "image":       return renderImage(entry);
      case "finding":     return renderFinding(entry);
      case "rawError":    return renderRawError(entry);
      default: {
        const div = document.createElement("div");
        div.className = "entry";
        div.textContent = "(unknown entry)";
        return div;
      }
    }
  }

  function renderBanner(entry) {
    const div = document.createElement("div");
    div.className = "entry banner";
    div.textContent = entry.text;
    return div;
  }

  function renderEcho(entry) {
    const div = document.createElement("div");
    div.className = "entry echo";

    const p = document.createElement("span");
    p.className = "prompt";
    p.textContent = entry.prompt + " ";
    div.appendChild(p);

    const code = document.createElement("span");
    code.className = "code";
    code.textContent = entry.code;
    div.appendChild(code);

    return div;
  }

  function renderText(entry, klass) {
    const div = document.createElement("div");
    div.className = `entry ${klass}`;
    // Empty strings (e.g. an empty print()) need a non-breaking space so the
    // entry still occupies a visible line.
    div.textContent = entry.text === "" ? "\u00a0" : entry.text;
    return div;
  }

  function renderResult(entry) {
    const div = document.createElement("div");
    div.className = "entry result";
    div.textContent = entry.repr;
    return div;
  }

  function renderImage(entry) {
    const div = document.createElement("div");
    div.className = "entry image";

    const wrap = document.createElement("div");
    wrap.className = "imgWrap";
    wrap.innerHTML = entry.svg;
    div.appendChild(wrap);

    const meta = document.createElement("div");
    meta.className = "imgMeta";

    const caption = document.createElement("span");
    caption.className = "caption";
    caption.textContent = entry.source || "image";
    meta.appendChild(caption);

    const dims = document.createElement("span");
    dims.className = "dims";
    dims.textContent = `${entry.width} \u00d7 ${entry.height}`;
    meta.appendChild(dims);

    const save = document.createElement("button");
    save.textContent = "Save SVG";
    save.title = "Download this image as an .svg file";
    save.addEventListener("click", () => {
      vscode.postMessage({ type: "saveSvg", svg: entry.svg, source: entry.source });
    });
    meta.appendChild(save);

    div.appendChild(meta);
    return div;
  }

  function renderFinding(entry) {
    const f = entry.finding;
    const div = document.createElement("div");
    div.className = "entry finding";

    const head = document.createElement("div");
    const errType = document.createElement("span");
    errType.className = "errType";
    errType.textContent = f.errorType + ": ";
    head.appendChild(errType);
    const headline = document.createElement("span");
    headline.className = "headline";
    headline.textContent = f.headline;
    head.appendChild(headline);
    div.appendChild(head);

    if (f.location) {
      const loc = document.createElement("span");
      loc.className = "loc";
      const link = document.createElement("a");
      link.textContent = "at " + f.location.label;
      link.addEventListener("click", () => {
        vscode.postMessage({
          type: "openLocation",
          fileName: f.location.fileName,
          line: f.location.line,
          column: f.location.column,
        });
      });
      loc.appendChild(link);
      div.appendChild(loc);
    }

    if (f.howToFix && f.howToFix.length > 0) {
      const t = document.createElement("div");
      t.className = "howTitle";
      t.textContent = "How to fix:";
      div.appendChild(t);

      const ul = document.createElement("ul");
      for (const item of f.howToFix) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      }
      div.appendChild(ul);
    }

    return div;
  }

  function renderRawError(entry) {
    const div = document.createElement("div");
    div.className = "entry rawError";

    const head = document.createElement("div");
    head.className = "head";
    head.textContent = `${entry.errorType}: ${entry.message}`;
    div.appendChild(head);

    if (entry.traceback && entry.traceback !== `${entry.errorType}: ${entry.message}`) {
      const pre = document.createElement("div");
      pre.style.whiteSpace = "pre-wrap";
      pre.textContent = entry.traceback;
      div.appendChild(pre);
    }
    return div;
  }

  // Input handling ---------------------------------------------

  function autoSizeInput() {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  }

  function submitCurrent() {
    if (state.busy) return;
    const code = textarea.value;
    textarea.value = "";
    autoSizeInput();
    if (code.trim().length > 0) {
      pushHistory(code);
    }
    historyIdx = -1;
    historyDraft = "";
    vscode.postMessage({ type: "submit", code });
  }

  function pushHistory(code) {
    if (state.history.length > 0 && state.history[state.history.length - 1] === code) {
      return;
    }
    state.history.push(code);
    if (state.history.length > 200) {
      state.history.splice(0, state.history.length - 200);
    }
    persist();
  }

  function caretAtFirstLine() {
    const pos = textarea.selectionStart;
    return textarea.value.indexOf("\n") === -1 || pos <= textarea.value.indexOf("\n");
  }
  function caretAtLastLine() {
    const pos = textarea.selectionStart;
    const lastNL = textarea.value.lastIndexOf("\n");
    return lastNL === -1 || pos > lastNL;
  }

  function historyPrev() {
    if (state.history.length === 0) return;
    if (historyIdx === -1) {
      historyDraft = textarea.value;
      historyIdx = state.history.length - 1;
    } else if (historyIdx > 0) {
      historyIdx -= 1;
    } else {
      return;
    }
    textarea.value = state.history[historyIdx];
    autoSizeInput();
    placeCaretAtEnd();
  }

  function historyNext() {
    if (historyIdx === -1) return;
    historyIdx += 1;
    if (historyIdx >= state.history.length) {
      historyIdx = -1;
      textarea.value = historyDraft;
      historyDraft = "";
    } else {
      textarea.value = state.history[historyIdx];
    }
    autoSizeInput();
    placeCaretAtEnd();
  }

  function placeCaretAtEnd() {
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
  }

  textarea.addEventListener("input", () => {
    autoSizeInput();
    if (historyIdx !== -1) {
      historyIdx = -1;
      historyDraft = "";
    }
  });

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      if (event.shiftKey) {
        // Allow newline.
        return;
      }
      event.preventDefault();
      submitCurrent();
      return;
    }
    if (event.key === "ArrowUp" && caretAtFirstLine()) {
      event.preventDefault();
      historyPrev();
      return;
    }
    if (event.key === "ArrowDown" && caretAtLastLine()) {
      event.preventDefault();
      historyNext();
      return;
    }
    if (event.key === "c" && event.ctrlKey && !event.shiftKey && !event.altKey) {
      // Use Ctrl+C only if no selection - otherwise let the user copy.
      if (textarea.selectionStart === textarea.selectionEnd) {
        event.preventDefault();
        textarea.value = "";
        autoSizeInput();
        vscode.postMessage({ type: "interrupt" });
      }
      return;
    }
    if (event.key === "l" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      vscode.postMessage({ type: "clearRequested" });
      return;
    }
  });

  clearBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "clearRequested" });
  });

  stream.addEventListener("scroll", () => {
    const slack = 16;
    stickToBottom = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) <= slack;
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "append":
        if (state.mode !== "session") return;
        appendEntry(msg.entry);
        break;
      case "clear":
        if (state.mode !== "session") return;
        clearStream();
        break;
      case "prompt":
        if (state.mode !== "session") return;
        state.prompt = msg.kind === "continuation" ? "continuation" : "primary";
        setPromptText();
        persist();
        break;
      case "busy":
        if (state.mode !== "session") return;
        setBusy(!!msg.busy, msg.status);
        break;
      case "replay":
        // Switch to (or stay in) session mode.
        state.mode = "session";
        state.title = typeof msg.title === "string" ? msg.title : "";
        state.entries = Array.isArray(msg.entries) ? msg.entries.slice() : [];
        state.prompt = msg.prompt === "continuation" ? "continuation" : "primary";
        state.busy = !!msg.busy;
        persist();
        applyMode();
        applyTitle();
        renderAll();
        setPromptText();
        setBusy(state.busy, msg.status);
        break;
      case "empty":
        state.mode = "empty";
        state.emptyMessage = msg.message || state.emptyMessage;
        state.title = "";
        state.entries = [];
        state.busy = false;
        persist();
        applyMode();
        applyTitle();
        renderAll();
        setBusy(false);
        break;
      case "title":
        if (state.mode !== "session") return;
        state.title = typeof msg.title === "string" ? msg.title : "";
        persist();
        applyTitle();
        break;
      case "focusInput":
        if (state.mode === "session") textarea.focus();
        break;
    }
  });

  // Initial render --------------------------------------------

  applyMode();
  applyTitle();
  setPromptText();
  setBusy(state.busy);
  renderAll();

  // Tell the host we're alive and ready to receive a fresh replay/empty.
  vscode.postMessage({ type: "ready" });
})();
