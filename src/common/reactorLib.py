# Python Language Levels: interactive reactors (big-bang / animate).
#
# Loaded into Pyodide after imageLib, so `to_draw` handlers can use the
# image primitives without importing anything.
#
# A reactor is a *value*: it holds the handlers plus the current state, and
# `react` returns a new reactor rather than mutating one. That is what makes
# stepping backwards possible - the trace is simply the states we have seen,
# and rewinding is re-drawing one of them.
#
# Nothing in here runs an event loop. The extension host owns the clock (and
# the socket, for the universe client) and calls `_pll_reactor_step` once per
# event. A loop in here would hold the worker and the whole exec chain for as
# long as the animation ran, which is the failure mode `Stop` exists for.

import contextlib as _rx_contextlib
import json as _rx_json
import sys as _rx_sys

_PLL_DEFAULT_TICK_RATE = 1.0 / 28.0

# Longest trace we keep. A reactor left running for an hour at 28 ticks a
# second would otherwise hold 100k states alive just so it could rewind.
_PLL_MAX_TRACE = 10000

def _pll_rx_suggestion(unknown):
    """" Did you mean `on_tick`?", when one of them is nearly a real one."""
    for given in unknown:
        best = _pll_closest_name(given, _PLL_HANDLER_NAMES)
        if best is not None:
            return " Did you mean `%s`?" % best
    return ""


_PLL_HANDLER_NAMES = (
    "init",
    "to_draw",
    "on_tick",
    "tick_rate",
    "stop_when",
    "on_key",
    "on_mouse",
    "on_receive",
    "register",
    "title",
)


class _PllPackage:
    """A new state, plus a message to send to the server."""

    __slots__ = ("state", "message")

    def __init__(self, state, message):
        self.state = state
        self.message = message

    def __repr__(self):
        return "package(%r, %r)" % (self.state, self.message)


def package(state, message):
    """Return `state` to the reactor and send `message` to the server."""
    return _PllPackage(state, message)


def _pll_split_package(result):
    """`(state, messages)` for whatever a handler returned."""
    if isinstance(result, _PllPackage):
        return result.state, (result.message,)
    return result, ()


class Reactor:
    """An interactive program: handlers plus the state they act on.

    Build one with `reactor(...)`. Every method that advances it returns a
    *new* Reactor, so a reactor you are holding never changes underneath
    you - `r.react(...)` twice from the same `r` gives the same answer.
    """

    __slots__ = ("_h", "_state", "_trace", "_tracing", "_outbox", "_shown")

    def __init__(self, handlers, state, trace=None, tracing=False, outbox=()):
        self._h = handlers
        self._state = state
        self._trace = list(trace) if trace else []
        self._tracing = tracing
        self._outbox = tuple(outbox)
        # Set by `interact()` on the reactor it hands back, so a top-level
        # `big_bang(...)` shows its card and not also its repr.
        self._shown = False

    @property
    def _pll_already_displayed(self):
        return self._shown

    def _pll_image_data(self):
        """Display protocol: a reactor shows the picture for its state.

        So `r` at the prompt draws the current frame, the same way a bare
        image or table displays itself.
        """
        return self.draw()._pll_image_data()

    # -- plumbing -----------------------------------------------------

    def _next(self, state, messages=()):
        trace = self._trace
        if self._tracing and len(trace) < _PLL_MAX_TRACE:
            trace = trace + [state]
        return Reactor(self._h, state, trace, self._tracing, messages)

    def _handler(self, name):
        return self._h.get(name)

    # -- inspection ---------------------------------------------------

    def get_value(self):
        """The current state."""
        return self._state

    def draw(self):
        """The image for the current state."""
        return self._h["to_draw"](self._state)

    def is_stopped(self):
        """True when `stop_when` says this state is the last one."""
        stop = self._handler("stop_when")
        return bool(stop(self._state)) if stop else False

    @property
    def title(self):
        return self._h.get("title") or "reactor"

    @property
    def tick_rate(self):
        return self._h.get("tick_rate", _PLL_DEFAULT_TICK_RATE)

    @property
    def register(self):
        return self._h.get("register")

    def handles(self, name):
        """Whether this reactor has the named handler."""
        return self._handler(name) is not None

    def outgoing(self):
        """Messages the last `react` asked to send to the server."""
        return list(self._outbox)

    # -- advancing ----------------------------------------------------

    def react(self, event):
        """A new reactor with one event applied.

        `event` is a dict: `{"kind": "tick"}`, `{"kind": "key", "key": "left"}`,
        `{"kind": "mouse", "x": 1, "y": 2, "event": "button-down"}`, or
        `{"kind": "receive", "message": ...}`. An event this reactor has no
        handler for leaves the state alone.
        """
        kind = event.get("kind") if isinstance(event, dict) else None
        if kind == "tick":
            handler = self._handler("on_tick")
            args = (self._state,)
        elif kind == "key":
            handler = self._handler("on_key")
            args = (self._state, event.get("key", ""))
        elif kind == "mouse":
            handler = self._handler("on_mouse")
            args = (
                self._state,
                event.get("x", 0),
                event.get("y", 0),
                event.get("event", "move"),
            )
        elif kind == "receive":
            handler = self._handler("on_receive")
            args = (self._state, event.get("message"))
        else:
            raise ValueError("react: unknown event kind %r" % (kind,))
        if handler is None:
            return self
        state, messages = _pll_split_package(handler(*args))
        return self._next(state, messages)

    def tick(self):
        """Shorthand for `react({"kind": "tick"})`."""
        return self.react({"kind": "tick"})

    # -- tracing ------------------------------------------------------

    def start_trace(self):
        """A new reactor that records every state it passes through."""
        return Reactor(self._h, self._state, [self._state], True, self._outbox)

    def stop_trace(self):
        """A new reactor that stops recording, keeping what it has."""
        return Reactor(self._h, self._state, self._trace, False, self._outbox)

    def get_trace(self):
        """The states recorded so far, oldest first."""
        return list(self._trace)

    def simulate_trace(self, limit):
        """Run up to `limit` ticks with tracing on, stopping at `stop_when`.

        No drawing and no clock: this is the way to test a reactor's logic
        at the prompt, or in a test, without watching it.
        """
        if limit < 0:
            raise ValueError("simulate_trace needs a limit of at least 0")
        current = self.start_trace()
        for _ in range(limit):
            if current.is_stopped():
                break
            nxt = current.tick()
            if nxt is current:
                break  # no on_tick handler; nothing would ever change
            current = nxt
        return current

    def interact(self):
        """Show this reactor in the interactions panel and start it."""
        return _pll_reactor_interact(self)

    def __repr__(self):
        return "<reactor %s state=%r>" % (self.title, self._state)


#: Reactors made during the current run. A reactor that is never started
#: does nothing and says nothing - the commonest way a universe program
#: appears to do nothing at all - so the run ends with a note about it.
#: Cleared at the start of every run by `_pll_reset_reactor_notes`.
_pll_made_reactors = []


def _pll_reset_reactor_notes():
    del _pll_made_reactors[:]


def _pll_reactor_note():
    """A note about reactors that were built and never started, or "".

    Written to stderr at the end of a run: there is nothing to report
    until the program has finished, and nothing wrong with building a
    reactor and starting it later in the same program.
    """
    idle = [r for r in _pll_made_reactors if not r._pll_already_displayed]
    if not idle:
        return ""
    if len(idle) == 1:
        return (
            "note: a reactor was made but never started, so nothing ran. "
            "Add `.interact()` to start it.\n"
        )
    return (
        "note: %d reactors were made but never started, so nothing ran. "
        "Add `.interact()` to start them.\n" % len(idle)
    )


def reactor(**handlers):
    """Build a reactor. `init` and `to_draw` are required.

    Handlers: `on_tick(state)`, `on_key(state, key)`,
    `on_mouse(state, x, y, event)`, `on_receive(state, message)`,
    `stop_when(state)`, plus `tick_rate` (seconds), `title`, and `register`
    (a `ws://` URL for the universe client).
    """
    unknown = [k for k in handlers if k not in _PLL_HANDLER_NAMES]
    if unknown:
        raise ValueError(
            "reactor has no handler called %s.%s The handlers are: %s"
            % (
                ", ".join("`%s`" % u for u in sorted(unknown)),
                _pll_rx_suggestion(sorted(unknown)),
                ", ".join(_PLL_HANDLER_NAMES),
            )
        )
    if "init" not in handlers:
        raise ValueError("reactor: needs an `init` state")
    if "to_draw" not in handlers:
        raise ValueError("reactor: needs a `to_draw` handler")
    for name in ("to_draw", "on_tick", "stop_when", "on_key", "on_mouse", "on_receive"):
        fn = handlers.get(name)
        if fn is not None and not callable(fn):
            raise ValueError(
                "reactor's `%s` has to be a function, written as its name "
                "with no brackets after it." % name
            )
    rate = handlers.get("tick_rate", _PLL_DEFAULT_TICK_RATE)
    if not isinstance(rate, (int, float)) or isinstance(rate, bool) or rate <= 0:
        raise ValueError("reactor: `tick_rate` must be a number of seconds above 0")
    state = handlers.pop("init")
    handlers["tick_rate"] = float(rate)
    made = Reactor(handlers, state)
    _pll_made_reactors.append(made)
    return made


def big_bang(init, **handlers):
    """Build a reactor and start it. Racket's `big-bang`."""
    handlers["init"] = init
    return reactor(**handlers).interact()


def animate(to_draw, **handlers):
    """Animate `to_draw(n)`, where `n` counts ticks from 0. Racket's `animate`."""
    handlers.setdefault("init", 0)
    handlers.setdefault("on_tick", lambda n: n + 1)
    handlers["to_draw"] = to_draw
    return reactor(**handlers).interact()


PLL_REACTOR_EXPORTS = [
    "Reactor",
    "reactor",
    "package",
    "big_bang",
    "animate",
]


# -----------------------------------------------------------------------------
# Running reactors (driven by the extension host, one event per call)
# -----------------------------------------------------------------------------

_pll_reactors = {}
_pll_reactor_seq = 0


class _PllRunning:
    """A reactor being interacted with, plus the frames it has been through.

    The history is a list of `(reactor, event)` pairs with a cursor, rather
    than a list of states, so rewinding and then playing forward again is
    *replay* - the same reactor values, not a recomputation that could drift
    if a handler is not deterministic. A new event at a rewound cursor
    discards the frames after it, exactly like an editor's undo history.
    """

    __slots__ = ("frames", "cursor", "dropped", "main")

    def __init__(self, reactor_value):
        self.frames = [(reactor_value, None)]
        # The module the program ran as, which its handlers run as too.
        self.main = _rx_sys.modules["__main__"]
        self.cursor = 0
        # Frames aged out of the front, so the card can still number them.
        self.dropped = 0

    @property
    def current(self):
        return self.frames[self.cursor][0]

    def seek(self, index):
        self.cursor = max(0, min(index, len(self.frames) - 1))
        return self.current

    def step(self, event):
        """Advance by one event. True if the frame was newly computed.

        The return value matters for the universe client: a *replayed* frame
        still carries the messages its handler produced the first time, and
        re-sending them because the student dragged the slider back and
        played forward would be wrong.
        """
        ahead = self.cursor + 1
        # Exact redo: the frame we already have came from this same event.
        if ahead < len(self.frames) and self.frames[ahead][1] == event:
            self.cursor = ahead
            return False
        del self.frames[ahead:]
        nxt = self.current.react(event)
        self.frames.append((nxt, event))
        self.cursor = len(self.frames) - 1
        if len(self.frames) > _PLL_MAX_TRACE:
            drop = len(self.frames) - _PLL_MAX_TRACE
            del self.frames[:drop]
            self.dropped += drop
            self.cursor -= drop
        return True


def _pll_reactor_frame(image):
    return {
        "data": image.to_svg(),
        "width": int(image.width) + (1 if image.width % 1 else 0),
        "height": int(image.height) + (1 if image.height % 1 else 0),
    }


def _pll_reactor_view(rid, running):
    """What the host needs to render the current frame."""
    current = running.current
    return {
        "ok": True,
        "id": rid,
        "frame": _pll_reactor_frame(current.draw()),
        "index": running.dropped + running.cursor,
        "length": running.dropped + len(running.frames),
        "at_end": running.cursor == len(running.frames) - 1,
        "stopped": current.is_stopped(),
        "value_repr": repr(current.get_value()),
    }


def _pll_reactor_failure(exc):
    failure = {"ok": False}
    failure.update(_pll_error_info(exc))
    return failure


def _pll_reactor_interact(reactor_value):
    """Register a reactor and emit the card that will drive it."""
    global _pll_reactor_seq
    _pll_reactor_seq += 1
    rid = "r%d" % _pll_reactor_seq
    running = _PllRunning(reactor_value)
    _pll_reactors[rid] = running
    payload = {
        "type": "reactor",
        "id": rid,
        "title": reactor_value.title,
        "tick_rate": reactor_value.tick_rate,
        "ticking": reactor_value.handles("on_tick"),
        "wants_keys": reactor_value.handles("on_key"),
        "wants_mouse": reactor_value.handles("on_mouse"),
        "register": reactor_value.register,
    }
    payload.update(_pll_reactor_view(rid, running))
    payload.pop("ok", None)
    _pll_push(payload)
    reactor_value._shown = True
    return reactor_value


def _pll_reactor_step(rid, event_json):
    """Apply one event to a running reactor and return the new frame."""
    running = _pll_reactors.get(rid)
    if running is None:
        return {"ok": False, "gone": True}
    # What the handlers print goes where the program's own output goes, not
    # to the worker's console, where a student debugging `on_tick` with
    # `print` would see nothing at all.
    stdout = _PllStream("stdout")
    stderr = _PllStream("stderr")
    try:
        event = _rx_json.loads(event_json)
        with (
            _pll_as_main(running.main),
            _rx_contextlib.redirect_stdout(stdout),
            _rx_contextlib.redirect_stderr(stderr),
        ):
            computed = running.step(event)
            view = _pll_reactor_view(rid, running)
        outgoing = []
        for message in running.current.outgoing() if computed else ():
            try:
                outgoing.append(_rx_json.dumps(message))
            except (TypeError, ValueError):
                return {
                    "ok": False,
                    "error_type": "TypeError",
                    "error_message": (
                        "package(...) can only send values the server can read: "
                        "numbers, strings, True/False, None, lists and dicts of "
                        "those. Got %r." % (message,)
                    ),
                    "traceback": "",
                }
        view["messages"] = outgoing
        return view
    except BaseException as e:
        return _pll_reactor_failure(e)


def _pll_reactor_seek(rid, index):
    """Show an earlier (or later) frame without applying an event."""
    running = _pll_reactors.get(rid)
    if running is None:
        return {"ok": False, "gone": True}
    try:
        with _pll_as_main(running.main):
            running.seek(int(index) - running.dropped)
            return _pll_reactor_view(rid, running)
    except BaseException as e:
        return _pll_reactor_failure(e)


def _pll_reactor_dispose(rid):
    """Forget a reactor, so its states and trace can be collected."""
    _pll_reactors.pop(rid, None)
    return True

