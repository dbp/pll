// PLL interactions view client.
//
// Lives inside the WebviewView. Holds the currently-displayed session's
// entry log + an input row, and talks to the extension host via postMessage.
// The session manager on the host owns per-file session state, and shows
// it whenever this view (re)loads and says it is ready. The one thing only
// the view knows is the prompt's input history, and that is all it saves.
//
// The messages, in summary. Their types are `HostToView` and `ViewToHost`
// in src/editor/panel/view.ts, which also checks every message this
// sends before acting on it.
//
// Host -> view:
//   { type: "appendMany", entries }          - append a batch of entries
//   { type: "reactorPatch", id, patch }      - update a live reactor card
//   { type: "clear" }                        - clear current session entries
//   { type: "show", entries, state }         - show a session, from scratch
//   { type: "state", state }                 - the header and the input row
//   { type: "focusInput" }
//
// `state` is a `PanelState`: { title, prompt, status, awaitingInput, inputPrefix }.
//
// View -> host:
//   { type: "ready" }                        - (re)loaded; show me a session
//   { type: "submit", code }
//   { type: "interrupt" }
//   { type: "clearRequested" }
//   { type: "reactorControl", id, action, index? }
//   { type: "reactorInput", id, event }
//   { type: "openLocation", fileName, line, column? }
//   { type: "saveSvg", svg, source? }
//   { type: "saveCsv", csv, source? }

(function () {
  const vscode = acquireVsCodeApi();

  // VS Code in the browser keeps this frame hidden, holding back every
  // message for it, until it sees the frame's `load` event, or for 200ms if
  // none comes. AdGuard for Safari holds back the real `load` and later fires
  // its own copy at the window. The host takes the copy for the load, stops
  // waiting, and - the copy's target is the window, not the document it
  // checks for - never shows the frame: the panel stays blank. Stopped here,
  // before the host's listener, the copy leaves the host its 200ms.
  window.addEventListener("load", (event) => {
    if (!event.isTrusted && event.target === window) event.stopImmediatePropagation();
  }, true);

  const saved = vscode.getState();
  /** Whether the host has shown a session yet - which it does almost at once. */
  let shown = false;
  /** The session's entries, as shown. */
  let entries = [];
  /** @type {{ title: string, prompt: "primary" | "continuation", status: string | null, awaitingInput: boolean, inputPrefix: string }} */
  let panel = { title: "", prompt: "primary", status: null, awaitingInput: false, inputPrefix: "" };
  /** The prompt's input history: what only this view knows, and all it saves. */
  const history = Array.isArray(saved?.history) ? saved.history : [];

  const body = document.body;
  const titleEl = document.getElementById("title");
  const stream = document.getElementById("stream");
  const empty = document.getElementById("empty");
  const inputRow = document.getElementById("inputRow");
  const promptEl = document.getElementById("prompt");
  const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById("input"));
  const statusEl = document.getElementById("status");
  const clearBtn = document.getElementById("clear");
  const stopBtn = document.getElementById("stop");
  /** Live reactor cards by id -> the parts a patch has to touch. */
  const reactorCards = new Map();

  let historyIdx = -1;
  /** Buffer of the user's draft when they start scrolling history. */
  let historyDraft = "";
  /** Track whether the stream is scrolled (close to) the bottom; if so, auto-scroll. */
  let stickToBottom = true;

  /**
   * An element: `h("div", { className: "entry banner" }, "text", child)`.
   * Props are set as properties, and `on...` ones are listeners; children
   * are nodes or strings, or arrays of them, and a null or false one is
   * left out.
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else el[key] = value;
    }
    el.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
    return el;
  }

  const post = (message) => vscode.postMessage(message);
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

  /**
   * Save what only this view knows. The entries are not saved: the host
   * shows them again on every load, and saving them meant serialising the
   * whole log - every SVG with it - on each reactor frame, 28 times a second.
   */
  function persist() {
    vscode.setState({ history });
  }

  /** The header and the input row, from `panel`. */
  function applyPanel() {
    body.classList.toggle("mode-waiting", !shown);
    body.classList.toggle("mode-session", shown);
    titleEl.textContent = panel.title;
    promptEl.textContent = panel.awaitingInput
      ? panel.inputPrefix
      : panel.prompt === "continuation" ? "..." : ">>>";
    // Busy, except that a program waiting in `input()` takes a line.
    const blocked = panel.status !== null && !panel.awaitingInput;
    inputRow.classList.toggle("busy", blocked);
    inputRow.classList.toggle("awaiting-input", panel.awaitingInput);
    textarea.disabled = blocked;
    // Only offered while a program is actually running.
    stopBtn.hidden = !blocked;
    statusEl.textContent = panel.status ?? "";
    // Back to the prompt once it takes a line - but only while the panel has
    // focus: the header changes as the file is edited, and the editor's keys
    // must stay in the editor.
    if (!blocked && shown) {
      requestAnimationFrame(() => {
        if (document.hasFocus()) textarea.focus();
      });
    }
    if (entries.length === 0) renderEmpty();
  }

  /** The caption of a stream with nothing in it: a spinner while busy. */
  function renderEmpty() {
    const busy = shown && panel.status !== null;
    empty.classList.toggle("busy", busy);
    const caption = h("span", {}, busy ? panel.status : shown ? "Run the file or evaluate an expression at the prompt below." : "");
    empty.replaceChildren(...(busy ? [h("span", { className: "spinner", ariaHidden: "true" }), caption] : [caption]));
  }

  function renderAll() {
    // The cards drawn now are the only ones with a clock.
    for (const card of reactorCards.values()) clearInterval(card.clock);
    reactorCards.clear();
    if (entries.length === 0) {
      renderEmpty();
      stream.replaceChildren(empty);
      return;
    }
    stream.replaceChildren(...entries.map(buildEntryNode));
    scrollToBottom();
  }

  /**
   * Append a batch of entries with one DOM insertion and one scroll. Doing
   * those per entry is what made a printing loop unusable.
   */
  function appendEntries(batch) {
    if (!batch || batch.length === 0) return;
    empty.remove();
    entries.push(...batch);
    stream.append(...batch.map(buildEntryNode));
    if (stickToBottom) scrollToBottom();
  }

  function scrollToBottom() {
    stream.scrollTop = stream.scrollHeight;
  }

  function buildEntryNode(entry) {
    switch (entry.kind) {
      case "banner":
        return h("div", { className: "entry banner" }, entry.text);
      case "echo":
        // Spaced as the input row spaces its prompt, so a line is shown
        // where it was typed, and the next can be lined up under it.
        return h("div", { className: "entry echo" },
          h("span", { className: "prompt" }, entry.prompt),
          h("span", { className: "code" }, entry.code));
      case "stdout":
      case "stderr":
        // An empty line (`print()`) still takes up one.
        return h("div", { className: `entry ${entry.kind}` }, entry.text === "" ? " " : entry.text);
      case "result":
        return h("div", { className: "entry result" }, entry.repr);
      case "image":       return renderImage(entry);
      case "table":       return renderTable(entry);
      case "finding":     return h("div", { className: "entry finding" }, ...findingParts(entry.finding));
      case "rawError":
        return h("div", { className: "entry rawError" }, h("div", { className: "head" }, `${entry.errorType}: ${entry.message}`));
      case "testReport":  return renderTestReport(entry);
      case "reactor":     return renderReactor(entry);
      case "examplar":    return renderExamplar(entry);
      default:            return h("div", { className: "entry" }, "(unknown entry)");
    }
  }

  function renderImage(entry) {
    return h("div", { className: "entry card image" },
      h("div", { className: "imgWrap", innerHTML: entry.svg }),
      h("div", { className: "meta" },
        h("span", { className: "caption" }, entry.source || "image"),
        h("span", { className: "dims" }, `${entry.width} × ${entry.height}`),
        h("button", {
          title: "Download this image as an .svg file",
          onclick: () => post({ type: "saveSvg", svg: entry.svg, source: entry.source }),
        }, "Save SVG")));
  }

  function renderTable(entry) {
    const caption = entry.truncated
      ? `Showing ${entry.shownCount} of ${entry.rowCount} rows`
      : `${plural(entry.rowCount, "row")} × ${plural(entry.columns.length, "column")}`;
    return h("div", { className: "entry card table" },
      h("div", { className: "tableWrap" },
        h("table", {},
          h("thead", {}, h("tr", {}, entry.columns.map((name) => h("th", {}, name)))),
          // Columns of numbers to the right, by what Python holds: text that
          // looks like a number stays on the left, so it can be seen to be text.
          h("tbody", {}, entry.rows.map((row) =>
            h("tr", {}, row.map((cell, i) => h("td", { className: entry.numeric?.[i] ? "num" : "" }, cell))))))),
      h("div", { className: "meta" },
        h("span", { className: "caption" }, caption),
        h("button", {
          title: entry.csvRows < entry.rowCount
            ? `Download the first ${entry.csvRows} rows as a .csv file - the whole table is too big to save from here`
            : "Download this table as a .csv file (full table, not just the visible rows)",
          onclick: () => post({ type: "saveCsv", csv: entry.csv, source: entry.source }),
        }, "Save CSV")));
  }

  /** A link to `line` of `fileName`, which the host opens. */
  function locationLink(fileName, line, column, label, className) {
    return h("a", {
      className,
      onclick: () => post({ type: "openLocation", fileName, line, column }),
    }, label);
  }

  /**
   * A finding's parts - headline, where, and how to fix it. Shared by a
   * finding entry and a test that raised, so an error reads the same
   * wherever it is shown.
   */
  function findingParts(f) {
    return [
      h("div", {}, h("span", { className: "errType" }, f.errorType + ": "), h("span", { className: "headline" }, f.headline)),
      f.location && h("span", { className: "loc" },
        locationLink(f.location.fileName, f.location.line, f.location.column, "at " + f.location.label)),
      f.howToFix?.length > 0 && h("div", { className: "howTitle" }, "How to fix:"),
      f.howToFix?.length > 0 && h("ul", {}, f.howToFix.map((item) => h("li", {}, item))),
    ];
  }

  /** What each outcome is marked with: a square for a Stop, as on its button - not a failure's cross. */
  const MARKS = { passed: "✓", skipped: "–", stopped: "■" };

  function renderTestReport(entry) {
    const failed = (entry.failed || 0) + (entry.errors || 0);
    const parts = [
      entry.passed && `${entry.passed} passed`,
      entry.failed && `${entry.failed} failed`,
      entry.errors && plural(entry.errors, "error"),
      entry.skipped && `${entry.skipped} skipped`,
      entry.stopped && (entry.stoppedIn ? "stopped during " + entry.stoppedIn : "stopped before any test ran"),
    ].filter(Boolean);
    const tests = entry.tests || [];
    // A stopped phase is neither a pass nor a failure: the student ended it.
    return h("div", { className: "entry card testReport " + (entry.stopped ? "stopped" : failed > 0 ? "failed" : "passed") },
      h("div", { className: "summary" }, "Tests: " + (parts.length > 0 ? parts.join(", ") : "no tests collected")),
      tests.length > 0 && h("div", { className: "testList" }, tests.map((t) => [
        h("div", { className: "testRow " + (t.outcome || "") },
          h("span", { className: "mark" }, MARKS[t.outcome] ?? "✗"),
          h("span", { className: "name" }, t.name),
          t.lineNumber != null && entry.fileName &&
            locationLink(entry.fileName, t.lineNumber, null, `at ${entry.fileName}:${t.lineNumber}`, "loc")),
        t.finding
          ? h("div", { className: "testFinding finding" }, ...findingParts(t.finding))
          : t.message && h("div", { className: "testMsg" }, t.message),
        t.stdout && h("div", { className: "testStdout" }, t.stdout),
      ])));
  }

  /* ---- Examplar ---------------------------------------------------- */

  /** The tone of an Examplar line, as a class. */
  const TONE = { good: "exGood", bad: "exBad", warn: "exWarn", note: "exNote" };

  /**
   * One Examplar verdict.
   *
   * A card per **function**, because that is the unit a student works in,
   * and because a global count with a "but you have no tests for `total`"
   * footnote underneath is a card arguing with itself. Within it, the two
   * phases as two labelled lines: *are these tests right?*, against correct
   * implementations, then *are they thorough?*, against buggy ones.
   *
   * Neither line says more than it has to. A disagreement gives the test's
   * name, not its assertion, which would state the correct answer; a buggy
   * implementation that got through gives its id, not its failure message,
   * which would describe the bug. Say which thing is wrong, never what is
   * right. The wording is the host's (run/examplar.ts), so the panel and
   * the command line say the same thing; this only draws it.
   */
  function renderExamplar(entry) {
    return h("div", { className: "entry examplar ex-" + (entry.card ?? "failed") },
      h("div", { className: "exHead" },
        h("span", { className: "exTitle" }, entry.card === "function" ? entry.name : "Your tests"),
        // A 304 means the bundle is current, not stale, so being served from
        // the store is not worth a badge - but it is worth being able to check.
        h("span", { className: "exSource", title: entry.cached ? `${entry.url} (cached copy)` : entry.url }, "Examplar")),
      (entry.body ?? []).map((block) => block.kind === "line"
        ? h("div", { className: "exLine " + TONE[block.tone] }, block.text)
        : h("div", { className: "exFailure " + (block.tone === "bad" ? "exFailureBad" : "exFailureWarn") },
            h("code", {}, block.name),
            block.detail && h("pre", {}, block.detail))));
  }

  /* ---- Reactors --------------------------------------------------- */

  /** DOM key names -> the names HtDP hands to `on_key`. */
  const KEY_NAMES = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    Enter: "\r", Tab: "\t", Backspace: "\b", Escape: "escape", Delete: "delete",
    Home: "home", End: "end", PageUp: "prior", PageDown: "next",
  };

  /** The `on_key` name of a key press, or null for a modifier on its own - which means nothing by itself. */
  function reactorKeyName(event) {
    return KEY_NAMES[event.key] ?? (event.key.length === 1 ? event.key : null);
  }

  const CONNECTION_LABELS = {
    connecting: "connecting…", open: "connected", closed: "disconnected", error: "connection failed", none: "",
  };

  function renderReactor(entry) {
    const send = (action, index) => post({ type: "reactorControl", id: entry.id, action, index });
    const card = { entry };
    const input = (event) => post({ type: "reactorInput", id: entry.id, event });
    const mouse = (kind) => (event) => {
      const box = card.stage.getBoundingClientRect();
      input({ kind: "mouse", x: Math.round(event.clientX - box.left), y: Math.round(event.clientY - box.top), event: kind });
    };
    const button = (label, title, onclick) => h("button", { title, onclick }, label);

    card.value = h("code", { className: "rxValue" });
    // Only worlds registered with a universe server have a connection to
    // report, so this stays hidden otherwise.
    card.link = h("span", { className: "rxLink", hidden: !entry.register });
    // `tabIndex` so the picture can take keyboard focus; without it a key
    // press would go to the prompt instead.
    card.stage = h("div", { className: "rxStage", innerHTML: entry.frame });
    if (entry.wantsKeys) {
      card.stage.tabIndex = 0;
      card.stage.addEventListener("keydown", (event) => {
        const key = reactorKeyName(event);
        if (key === null) return;
        // Arrows and space would otherwise scroll the panel.
        event.preventDefault();
        input({ kind: "key", key });
      });
    }
    if (entry.wantsMouse) {
      card.stage.addEventListener("mousedown", mouse("button-down"));
      card.stage.addEventListener("mouseup", mouse("button-up"));
      card.stage.addEventListener("mousemove", (e) => mouse(e.buttons ? "drag" : "move")(e));
      card.stage.addEventListener("mouseenter", mouse("enter"));
      card.stage.addEventListener("mouseleave", mouse("leave"));
    }
    card.reset = button("⏮", "Back to the first frame", () => send("reset"));
    // Mirrors the step button, bar and all: a bare "◀" read as "play
    // backwards", which is not what it does.
    card.back = button("❙◀", "One frame back", () => send("back", Math.max(0, (entry.index || 0) - 1)));
    card.play = button("▶", "Play", () => send(entry.playing ? "pause" : "play"));
    card.step = button("▶❙", "One frame forward", () => send("step"));
    card.scrub = h("input", { type: "range", className: "rxScrub", min: "0", oninput: () => send("seek", Number(card.scrub.value)) });
    card.counter = h("span", { className: "rxCounter" });
    reactorCards.set(entry.id, card);
    patchReactorCard(entry.id, entry);
    return h("div", { className: "entry card reactor" },
      h("div", { className: "rxHead" }, h("span", { className: "rxTitle" }, entry.title), card.link, card.value),
      card.stage,
      h("div", { className: "rxBar" }, card.reset, card.back, card.play, card.step, card.scrub, card.counter));
  }

  /** Apply a patch to a live card, touching only what changed. */
  function patchReactorCard(id, patch) {
    const card = reactorCards.get(id);
    if (!card) return;
    const e = Object.assign(card.entry, patch);
    if (patch.frame) card.stage.innerHTML = patch.frame;
    if (patch.valueRepr !== undefined) card.value.textContent = patch.valueRepr;
    if (e.register) {
      card.link.hidden = false;
      card.link.textContent = CONNECTION_LABELS[e.connection] || "";
      card.link.dataset.state = e.connection;
      card.link.title = e.connectionDetail ? `${e.register} - ${e.connectionDetail}` : e.register;
    }
    if (patch.playing !== undefined) setClock(card);
    card.play.textContent = e.playing ? "❙❙" : "▶";
    card.play.title = e.playing ? "Pause" : "Play";
    card.play.disabled = !e.ticking || (e.stopped && e.atEnd);
    card.step.disabled = !e.ticking;
    card.back.disabled = e.index <= 0;
    card.reset.disabled = e.index <= 0;
    const last = Math.max(0, e.length - 1);
    card.scrub.max = String(last);
    card.scrub.value = String(Math.min(e.index, last));
    card.scrub.disabled = last === 0;
    // The bar is the recorded history, and a running animation is always
    // at its newest frame - so while it plays, the bar is full. Saying
    // "live" is what makes that read as right rather than as stuck, the way
    // a live stream's player does. Replaying from an earlier frame moves
    // the thumb along the bar like any other playback.
    const live = e.playing && e.atEnd !== false && e.index >= last;
    card.counter.textContent = e.stopped
      ? `frame ${e.index} of ${last} · stopped`
      : live
        ? `frame ${e.index} · live`
        : `frame ${e.index} of ${last}`;
  }

  /**
   * A card's clock: a tick for the host every `tickRate` seconds while it
   * plays. It runs only while the card is drawn, so nothing advances while
   * the panel is hidden or shows another file. Floored at 10ms, so a tiny
   * rate cannot flood the host.
   */
  function setClock(card) {
    clearInterval(card.clock);
    card.clock = card.entry.playing
      ? setInterval(() => post({ type: "reactorControl", id: card.entry.id, action: "tick" }), Math.max(10, card.entry.tickRate * 1000))
      : undefined;
  }

  // Input handling ---------------------------------------------

  function autoSizeInput() {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  }

  function submitCurrent() {
    if (panel.status !== null && !panel.awaitingInput) return;
    const code = textarea.value;
    textarea.value = "";
    autoSizeInput();
    if (!panel.awaitingInput && code.trim().length > 0) {
      pushHistory(code);
    }
    historyIdx = -1;
    historyDraft = "";
    post({ type: "submit", code });
  }

  function pushHistory(code) {
    if (history.length > 0 && history[history.length - 1] === code) {
      return;
    }
    history.push(code);
    if (history.length > 200) {
      history.splice(0, history.length - 200);
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

  /** Show history entry `index`, or the draft when it is past the newest. */
  function showHistory(index) {
    historyIdx = index;
    if (index === -1) {
      textarea.value = historyDraft;
      historyDraft = "";
    } else {
      textarea.value = history[index];
    }
    autoSizeInput();
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
  }

  function historyPrev() {
    if (history.length === 0 || historyIdx === 0) return;
    if (historyIdx === -1) {
      historyDraft = textarea.value;
      showHistory(history.length - 1);
    } else {
      showHistory(historyIdx - 1);
    }
  }

  function historyNext() {
    if (historyIdx === -1) return;
    showHistory(historyIdx + 1 >= history.length ? -1 : historyIdx + 1);
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
      // Shift+Enter is a new line.
      if (event.shiftKey) return;
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
        post({ type: "interrupt" });
      }
      return;
    }
    if (event.key === "l" && mod) {
      event.preventDefault();
      post({ type: "clearRequested" });
    }
  });

  clearBtn.addEventListener("click", () => post({ type: "clearRequested" }));
  stopBtn.addEventListener("click", () => post({ type: "interrupt" }));

  // While a program runs the textarea is disabled, so its own Ctrl/Cmd+C
  // handler cannot fire. Catch the key on the document instead, and only
  // while blocked, so it never competes with copying from the stream.
  document.addEventListener("keydown", (event) => {
    if (panel.status === null || panel.awaitingInput) return;
    if (event.key !== "c" || !(event.ctrlKey || event.metaKey)) return;
    if (event.shiftKey || event.altKey) return;
    const selection = window.getSelection();
    if (selection && String(selection).length > 0) return;
    event.preventDefault();
    post({ type: "interrupt" });
  });

  stream.addEventListener("scroll", () => {
    const slack = 16;
    stickToBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight <= slack;
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    // Until a session is shown, there is nothing for the rest to act on.
    if (msg.type !== "show" && !shown) return;
    switch (msg.type) {
      case "appendMany":
        appendEntries(msg.entries);
        break;
      case "reactorPatch":
        patchReactorCard(msg.id, msg.patch);
        break;
      case "clear":
        entries = [];
        renderAll();
        break;
      case "show":
        shown = true;
        entries = Array.isArray(msg.entries) ? msg.entries.slice() : [];
        panel = msg.state;
        renderAll();
        applyPanel();
        break;
      case "state":
        panel = msg.state;
        applyPanel();
        break;
      case "focusInput":
        textarea.focus();
        break;
    }
  });

  // Initial render, and tell the host we are ready to be shown a session.
  applyPanel();
  renderAll();
  post({ type: "ready" });
})();
