# Helpers the libraries share: ordinals, describing a value, numbers, the
# closest name to a misspelling, and reading a source that is either a URL
# or a file next to the program.
#
# They live here because the libraries are exec'd into these globals
# afterwards, so "https:// means the network, anything else means a file" is
# decided in exactly one place and every library reports the same way when
# it goes wrong.

import re as _pll_src_re

_PLL_ORDINALS = ("1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th")


def _pll_ordinal(index):
    """`1st`, `2nd`, ... for a 0-based position.

    Used instead of the index itself wherever a message would otherwise
    have to say "Row 1" about the second row, or "argument 0".
    """
    if index < len(_PLL_ORDINALS):
        return _PLL_ORDINALS[index]
    return "%dth" % (index + 1)


def _pll_xml_escape(text):
    """`text` as it can appear in SVG, as content or inside an attribute."""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _pll_describe(value):
    """A value as a student would name it, for a message about it.

    One copy, here, because the image and table libraries are exec'd into
    these same globals: two definitions meant the second silently replaced
    the first, and whichever lost its turn stopped recognising its own
    types. An image was then described as `a _Rectangle`, naming a class
    nobody wrote.

    Images and tables are recognised by the same duck-typing the display
    code uses, so the bootstrap still does not depend on either library.
    """
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "%s" % value
    if isinstance(value, str):
        return 'the string "%s"' % value
    if isinstance(value, (int, float)):
        return "the number %s" % _pll_number(value)
    if hasattr(value, "_pll_image_data"):
        return "an image"
    if hasattr(value, "_pll_table_data"):
        return "a table"
    if isinstance(value, dict):
        return "a row" if type(value).__name__ == "Row" else "a dictionary"
    if isinstance(value, (list, tuple)):
        return "a list of %d" % len(value)
    if callable(value):
        return "the function `%s`" % getattr(value, "__name__", "given")
    name = type(value).__name__
    # A private class is PLL's own; a student has no name for it but the
    # thing it is.
    return "a value" if name.startswith("_") else "a %s" % name


def _pll_number(value):
    """`20`, not `20.0`, for a number in a message."""
    if isinstance(value, float) and value == int(value):
        return "%d" % int(value)
    return "%s" % value


def _pll_edit_distance(a, b):
    """Edit distance, counting a swap of two neighbours as one mistake.

    Plain Levenshtein charges two for `yaer` -> `year`, which is enough to
    push the commonest typo of all past any threshold tight enough to be
    useful. Lives here because the bootstrap is loaded before the image,
    table and reactor libraries, all of which suggest a name the student
    probably meant.
    """
    previous = list(range(len(b) + 1))
    two_back = []
    for i in range(1, len(a) + 1):
        current = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            current[j] = min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (0 if a[i - 1] == b[j - 1] else 1),
            )
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                current[j] = min(current[j], two_back[j - 2] + 1)
        two_back = previous
        previous = current
    return previous[len(b)]


def _pll_closest_name(name, candidates):
    """The candidate `name` was probably meant to be, or None.

    Close enough to be a misspelling rather than a different word: a third
    of the name's length, which covers `yaer` and `outilne` without
    turning an unrelated word into a confident guess.
    """
    if not isinstance(name, str):
        return None
    best = None
    best_distance = None
    # Sorted, so two candidates the same distance away always give the same
    # answer: a set's own order is arbitrary and can differ between runs.
    for candidate in sorted(candidates):
        distance = _pll_edit_distance(name.lower(), candidate.lower())
        if best_distance is None or distance < best_distance:
            best = candidate
            best_distance = distance
    if best is None:
        return None
    return best if best_distance <= max(1, len(best) // 3) else None


_PLL_SCHEME_RE = _pll_src_re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]*)://")


def _pll_source_is_url(source):
    """True when `source` names an address rather than a file."""
    match = _PLL_SCHEME_RE.match(source)
    return match is not None and match.group(1).lower() in ("http", "https")


def _pll_fetch_bytes(url, what):
    """GET `url` synchronously and return the body as bytes.

    Uses `XMLHttpRequest` rather than `pyodide.http.open_url`, because that
    decodes to text and an image is bytes - one path has to serve both.
    Synchronous XHR is fine here: Pyodide runs in a worker, never on a
    page's main thread.

    `overrideMimeType` is what keeps this portable. A browser would decode
    the body as UTF-8 and mangle every byte above 0x7f, so it is asked for
    `x-user-defined`, which maps bytes 0x80-0xff to U+F780-U+F7FF; masking
    with 0xff undoes that. On the desktop the polyfill ignores the call and
    hands back latin-1, where the mask is the identity. Same two lines of
    Python either way.
    """
    try:
        from js import XMLHttpRequest as _Xhr
    except ImportError:
        raise OSError(
            "%s cannot reach the network, so it cannot read %s." % (what, url)
        ) from None
    xhr = _Xhr.new()
    try:
        xhr.open("GET", url, False)
        xhr.overrideMimeType("text/plain; charset=x-user-defined")
        xhr.send(None)
    except Exception as e:
        # A failed cross-origin request looks like this, and it is the most
        # likely cause by far, so say so rather than repeating the browser's
        # famously unhelpful wording.
        raise OSError(
            "%s could not reach %s (%s). If that address is not your own, it "
            "may not allow other sites to read it." % (what, url, e)
        ) from None
    if xhr.status != 200:
        raise OSError(
            "%s could not read %s: the server answered %d."
            % (what, url, xhr.status)
        )
    return bytes(ord(c) & 0xFF for c in xhr.responseText)


def _pll_nearby_files(wanted):
    """" The files here are: cars.csv, trips.csv.", when there are any.

    A missing file is usually a misspelling or a file in another folder,
    and both are obvious the moment the actual names are in front of you.
    Only files with the same extension are listed, so asking for a CSV
    does not produce a directory listing of the whole project.
    """
    import os as _pll_os

    folder = _pll_os.path.dirname(wanted) or "."
    _, extension = _pll_os.path.splitext(wanted)
    try:
        names = sorted(
            name
            for name in _pll_os.listdir(folder)
            if not extension or name.lower().endswith(extension.lower())
        )
    except OSError:
        return ""
    if not names:
        return ""
    # A misspelling is the usual reason, and then one name is the answer.
    close = _pll_closest_name(_pll_os.path.basename(wanted), names)
    if close is not None:
        return ' Did you mean "%s"?' % close
    shown = names[:8]
    label = extension.lstrip(".").upper() + " " if extension else ""
    return " The %sfiles next to your program are: %s%s." % (
        label,
        ", ".join(shown),
        ", ..." if len(names) > len(shown) else "",
    )


def _pll_read_source(source, what, binary=False):
    """Read `source` - a URL or a path beside the program - and return it.

    Returns bytes when `binary`, otherwise text decoded as UTF-8.
    """
    if not isinstance(source, str):
        raise TypeError(
            "%s needs a file name or a URL as a string, not %r"
            % (what, type(source).__name__)
        )
    stripped = source.strip()
    if not stripped:
        raise ValueError("%s needs a file name or a URL; got an empty string" % what)

    if _pll_source_is_url(stripped):
        data = _pll_fetch_bytes(stripped, what)
    else:
        scheme = _PLL_SCHEME_RE.match(stripped)
        if scheme is not None:
            raise ValueError(
                "%s can read an https:// address or a file next to your "
                "program, but not a %s:// one." % (what, scheme.group(1))
            )
        try:
            with open(stripped, "rb") as handle:
                data = handle.read()
        except FileNotFoundError:
            nearby = _pll_nearby_files(stripped)
            raise FileNotFoundError(
                'There is no file called "%s" next to your program.%s'
                % (
                    stripped,
                    # A close name answers it; otherwise, say what to check.
                    nearby
                    if nearby.startswith(" Did you mean")
                    else nearby + " Check the spelling, or pass an https:// address instead.",
                )
            ) from None
        except IsADirectoryError:
            raise IsADirectoryError('"%s" is a folder, not a file.' % stripped) from None
    if binary:
        return data
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError(
            "%s could not read %r as text - it does not look like a text file."
            % (what, source)
        ) from None
