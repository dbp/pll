# Stop: the host's interrupt, delivered as `KeyboardInterrupt` once and
# acknowledged so the host stops re-sending it.

#: The worker's view of the interrupt buffer, set after this file loads, or
#: None when the host has no shared memory (and so no Stop at all). See
#: `interruptBuffer.ts` for the layout: byte 1 is the acknowledgement.
_pll_interrupt_view = None

#: How many Stops have been delivered, ever: a `KeyboardInterrupt` raised
#: while this did not move was raised by the program itself.
_pll_stops_delivered = 0


def _pll_on_sigint(signum, frame):
    """Deliver a Stop as `KeyboardInterrupt`, once, and say it was delivered.

    Pyodide's check can overwrite a Stop that arrives at the wrong moment,
    so the host re-asserts it until it is acknowledged. Two jobs follow:

      - acknowledge, by setting byte 1, so the host stops re-asserting;
      - ignore a repeat of a Stop already delivered. The host can store one
        more signal just before it sees the acknowledgement, and raising it
        would land a second `KeyboardInterrupt` in PLL's own clean-up after
        the first, turning a clean stop into an internal error.

    A new press clears byte 1 first, so a program that caught the first
    `KeyboardInterrupt` and carried on can still be stopped.
    """
    global _pll_stops_delivered
    view = _pll_interrupt_view
    if view is not None:
        try:
            if view[1]:
                return
            view[1] = 1
        except Exception:
            # A buffer without the second byte: an older host. Behave as
            # Python always has.
            pass
    _pll_stops_delivered += 1
    stop = KeyboardInterrupt()
    _pll_add_facts(stop, stop=True)
    raise stop


def _pll_install_sigint():
    """Route SIGINT through `_pll_on_sigint`. Called once, at load."""
    try:
        import signal as _pll_signal

        _pll_signal.signal(_pll_signal.SIGINT, _pll_on_sigint)
    except Exception:
        # No signal support: the default handler still raises.
        pass


_pll_install_sigint()


#: `wait(seconds)`, true if a Stop ended it early: set after this file
#: loads, beside `_pll_interrupt_view`, or None with no Stop to wait for.
_pll_wait_for_stop = None


def _pll_install_sleep():
    """Replace `time.sleep` with one a Stop ends at once.

    Pyodide sees a Stop between bytecodes, and a sleep runs none, so a Stop
    during `time.sleep(10)` would wait out the ten seconds. Otherwise it is
    `time.sleep` - the same arguments, the same errors.
    """
    import operator as _pll_operator
    import time as _pll_time

    original = _pll_time.sleep

    def sleep(secs):
        wait = _pll_wait_for_stop
        if wait is None:
            return original(secs)
        if not isinstance(secs, float):
            try:
                secs = _pll_operator.index(secs)
            except TypeError:
                # Not a length of time: the original raises, in its words.
                return original(secs)
        if secs != secs:
            raise ValueError("Invalid value NaN (not a number)")
        if secs < 0:
            raise ValueError("sleep length must be non-negative")
        if wait(secs):
            # Taken here rather than at the next bytecode check, which the
            # program could reach after the line that slept.
            _pll_interrupt_view[0] = 0
            _pll_on_sigint(2, None)

    sleep.__doc__ = original.__doc__
    sleep.__module__ = "time"
    _pll_time.sleep = sleep


_pll_install_sleep()
