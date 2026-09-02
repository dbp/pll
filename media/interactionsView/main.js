// PLL interactions view client.
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
//   { type: "awaitingInput", awaiting, prefix? } - program input() is waiting
//   { type: "replay", mode: "session", title, entries, prompt, busy, status?, awaitingInput?, inputPrefix? }
//   { type: "replay", mode: "session", title, entries, prompt, busy, status? }
//                                            - swap to a different session
//   { type: "empty", message }               - no session active
//   { type: "title", title }                 - update header title in place
//   { type: "focusInput" }
//   { type: "clipboard", op, text? }         - web copy/cut/paste (vscode.dev)
//
// View -> host messages:
//   { type: "ready" }
//   { type: "submit", code }
//   { type: "interrupt" }
//   { type: "clearRequested" }
//   { type: "openLocation", fileName, line, column? }
//   { type: "saveSvg", svg, source? }
//   { type: "viewFocus", focused }
//   { type: "clipboardResult", text, hadSelection }

(function () {
  const vscode = acquireVsCodeApi();

  /** @type {{ mode: "session" | "empty", emptyMessage: string, title: string, entries: any[], prompt: "primary" | "continuation", busy: boolean, status: string, awaitingInput: boolean, inputPrefix: string, history: string[] }} */
  const state = vscode.getState() ?? {
    mode: "empty",
    emptyMessage: "Open a Python file to start an interactions session.",
    title: "",
    entries: [],
    prompt: "primary",
    busy: false,
    status: "",
    awaitingInput: false,
    inputPrefix: "",
    history: [],
  };
  if (typeof state.awaitingInput !== "boolean") state.awaitingInput = false;
  if (typeof state.inputPrefix !== "string") state.inputPrefix = "";
  if (typeof state.status !== "string") state.status = "";

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
    if (state.awaitingInput) {
      promptEl.textContent = state.inputPrefix || "";
      return;
    }
    promptEl.textContent = state.prompt === "continuation" ? "..." : ">>>";
  }

  function applyInputEnabled() {
    const blocked = state.busy && !state.awaitingInput;
    inputRow.classList.toggle("busy", blocked);
    inputRow.classList.toggle("awaiting-input", state.awaitingInput);
    textarea.disabled = blocked;
    if (!blocked && state.mode === "session") {
      requestAnimationFrame(() => textarea.focus());
    }
  }

  function setBusy(busy, status) {
    state.busy = busy;
    state.status = busy ? (status || "Running...") : "";
    if (!busy) {
      state.awaitingInput = false;
      state.inputPrefix = "";
      setPromptText();
    }
    statusEl.textContent = state.status;
    applyInputEnabled();
    refreshEmptyIfNeeded();
    persist();
  }

  function setAwaitingInput(awaiting, prefix) {
    state.awaitingInput = !!awaiting;
    state.inputPrefix = awaiting ? (prefix || "") : "";
    setPromptText();
    applyInputEnabled();
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
    const busyWait = state.mode === "session" && state.busy;
    empty.classList.toggle("busy", busyWait);
    if (busyWait) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-hidden", "true");
      empty.appendChild(spinner);
    }
    const span = document.createElement("span");
    span.textContent = busyWait
      ? (state.status || "Running...")
      : state.mode === "empty"
        ? state.emptyMessage
        : SESSION_EMPTY_TEXT;
    empty.appendChild(span);
  }

  function refreshEmptyIfNeeded() {
    if (state.entries.length === 0 && empty.parentNode) {
      renderEmpty();
    }
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
      case "table":       return renderTable(entry);
      case "finding":     return renderFinding(entry);
      case "rawError":    return renderRawError(entry);
      case "testReport":  return renderTestReport(entry);
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

  function renderTable(entry) {
    const div = document.createElement("div");
    div.className = "entry table";

    const wrap = document.createElement("div");
    wrap.className = "tableWrap";

    const tbl = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const colName of entry.columns) {
      const th = document.createElement("th");
      th.textContent = colName;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    tbl.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of entry.rows) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        const td = document.createElement("td");
        td.textContent = cell;
        // Right-align cells that look like numbers.
        if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(cell)) {
          td.classList.add("num");
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    div.appendChild(wrap);

    const meta = document.createElement("div");
    meta.className = "tableMeta";

    const caption = document.createElement("span");
    caption.className = "caption";
    if (entry.truncated) {
      caption.textContent =
        "Showing " + entry.shownCount + " of " + entry.rowCount + " rows";
    } else {
      caption.textContent =
        entry.rowCount + " row" + (entry.rowCount === 1 ? "" : "s") +
        " \u00d7 " + entry.columns.length + " column" +
        (entry.columns.length === 1 ? "" : "s");
    }
    meta.appendChild(caption);

    const save = document.createElement("button");
    save.textContent = "Save CSV";
    save.title = "Download this table as a .csv file (full table, not just the visible rows)";
    save.addEventListener("click", () => {
      vscode.postMessage({
        type: "saveCsv",
        csv: tableToCsv(entry),
        source: entry.source,
      });
    });
    meta.appendChild(save);

    div.appendChild(meta);
    return div;
  }

  /** Format an entry's *displayed* rows as CSV. (Truncated tables export only
   *  the rows that came down the wire; that's an MVP limitation we accept.) */
  function tableToCsv(entry) {
    const escape = (s) => {
      const str = String(s);
      if (/[",\n\r]/.test(str)) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };
    const lines = [entry.columns.map(escape).join(",")];
    for (const row of entry.rows) {
      lines.push(row.map(escape).join(","));
    }
    return lines.join("\n") + "\n";
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

  function renderTestReport(entry) {
    const failed = (entry.failed || 0) + (entry.errors || 0);
    const div = document.createElement("div");
    div.className = "entry testReport " + (failed > 0 ? "failed" : "passed");

    const summary = document.createElement("div");
    summary.className = "summary";
    const parts = [];
    if (entry.passed) parts.push(entry.passed + " passed");
    if (entry.failed) parts.push(entry.failed + " failed");
    if (entry.errors) parts.push(entry.errors + " error" + (entry.errors === 1 ? "" : "s"));
    if (entry.skipped) parts.push(entry.skipped + " skipped");
    if (parts.length === 0) parts.push("no tests collected");
    summary.textContent = "Tests: " + parts.join(", ");
    div.appendChild(summary);

    const tests = entry.tests || [];
    if (tests.length > 0) {
      const list = document.createElement("div");
      list.className = "testList";
      for (const t of tests) {
        const row = document.createElement("div");
        row.className = "testRow " + (t.outcome || "");

        const mark = document.createElement("span");
        mark.className = "mark";
        if (t.outcome === "passed") mark.textContent = "\u2713";
        else if (t.outcome === "skipped") mark.textContent = "\u2013";
        else mark.textContent = "\u2717";
        row.appendChild(mark);

        const name = document.createElement("span");
        name.className = "name";
        name.textContent = t.name;
        row.appendChild(name);

        if (t.lineNumber != null && entry.fileName) {
          const loc = document.createElement("a");
          loc.className = "loc";
          loc.textContent = "at " + entry.fileName + ":" + t.lineNumber;
          loc.addEventListener("click", () => {
            vscode.postMessage({
              type: "openLocation",
              fileName: entry.fileName,
              line: t.lineNumber,
              column: null,
            });
          });
          row.appendChild(loc);
        }

        list.appendChild(row);

        if (t.message) {
          const msg = document.createElement("div");
          msg.className = "testMsg";
          msg.textContent = t.message;
          list.appendChild(msg);
        }
        if (t.stdout) {
          const out = document.createElement("div");
          out.className = "testStdout";
          out.textContent = t.stdout;
          list.appendChild(out);
        }
      }
      div.appendChild(list);
    }
    return div;
  }

  // Input handling ---------------------------------------------

  function autoSizeInput() {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  }

  function submitCurrent() {
    if (state.busy && !state.awaitingInput) return;
    const code = textarea.value;
    textarea.value = "";
    autoSizeInput();
    if (!state.awaitingInput && code.trim().length > 0) {
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

  function currentSelection() {
    if (document.activeElement === textarea) {
      if (textarea.selectionStart !== textarea.selectionEnd) {
        return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      }
      return "";
    }
    return window.getSelection()?.toString() ?? "";
  }

  function insertAtCaret(text) {
    if (textarea.disabled) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    const pos = start + text.length;
    textarea.setSelectionRange(pos, pos);
    textarea.dispatchEvent(new Event("input"));
    textarea.focus();
    autoSizeInput();
  }

  function reportClipboard(hadSelection, text) {
    vscode.postMessage({ type: "clipboardResult", hadSelection, text });
  }

  function clipboardCopyOrInterrupt() {
    const text = currentSelection();
    if (text) {
      reportClipboard(true, text);
      return;
    }
    reportClipboard(false, "");
    if (document.activeElement === textarea) {
      textarea.value = "";
      autoSizeInput();
      vscode.postMessage({ type: "interrupt" });
    }
  }

  function clipboardCut() {
    if (document.activeElement === textarea && textarea.selectionStart !== textarea.selectionEnd) {
      const text = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      insertAtCaret("");
      reportClipboard(true, text);
      return;
    }
    reportClipboard(false, "");
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
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === "c" && mod && !event.shiftKey && !event.altKey) {
      // Use Ctrl/Cmd+C only if no selection - otherwise let the user copy.
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
      case "awaitingInput":
        if (state.mode !== "session") return;
        setAwaitingInput(!!msg.awaiting, msg.prefix);
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
        setAwaitingInput(!!msg.awaitingInput, msg.inputPrefix);
        setPromptText();
        setBusy(state.busy, msg.status);
        break;
      case "empty":
        state.mode = "empty";
        state.emptyMessage = msg.message || state.emptyMessage;
        state.title = "";
        state.entries = [];
        state.busy = false;
        state.awaitingInput = false;
        state.inputPrefix = "";
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
      case "clipboard":
        if (msg.op === "copyOrInterrupt") {
          clipboardCopyOrInterrupt();
        } else if (msg.op === "cut") {
          clipboardCut();
        } else if (msg.op === "paste") {
          insertAtCaret(typeof msg.text === "string" ? msg.text : "");
        }
        break;
    }
  });

  function reportViewFocus(focused) {
    vscode.postMessage({ type: "viewFocus", focused });
  }
  let blurTimer = 0;
  function setViewFocus(focused) {
    if (focused) {
      window.clearTimeout(blurTimer);
      blurTimer = 0;
      reportViewFocus(true);
      return;
    }
    // vscode.dev / the workbench can blur the iframe while handling our
    // copy/paste keybinding. Wait so `pllInteractionsFocus` stays true
    // long enough for the when-clause to match.
    window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(() => {
      blurTimer = 0;
      reportViewFocus(false);
    }, 250);
  }
  window.addEventListener("focus", () => setViewFocus(true));
  window.addEventListener("blur", () => setViewFocus(false));
  document.addEventListener("focusin", () => setViewFocus(true));

  // Initial render --------------------------------------------

  applyMode();
  applyTitle();
  setPromptText();
  setBusy(state.busy);
  renderAll();

  // Tell the host we're alive and ready to receive a fresh replay/empty.
  vscode.postMessage({ type: "ready" });
})();
