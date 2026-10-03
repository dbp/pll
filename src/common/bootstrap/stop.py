# Stop: the host's interrupt, delivered as `KeyboardInterrupt` once and
# acknowledged so the host stops re-sending it.

#: The worker's view of the interrupt buffer, set after this file loads, or
#: None when the host has no shared memory (and so no Stop at all). See
#: `interruptBuffer.ts` for the layout: byte 1 is the acknowledgement.
_pll_interrupt_view = None


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
    raise KeyboardInterrupt


def _pll_install_sigint():
    """Route SIGINT through `_pll_on_sigint`. Called once, at load."""
    try:
        import signal as _pll_signal

        _pll_signal.signal(_pll_signal.SIGINT, _pll_on_sigint)
    except Exception:
        # No signal support: the default handler still raises.
        pass


_pll_install_sigint()
