# PLL image library.
#
# A small, immutable, HtDP-style image library inspired by Racket's
# `2htdp/image` and Pyret's `image-lib`. Every primitive and combinator
# returns a new `Image`; nothing mutates.
#
# An image is a tree: shapes at the leaves, combinators above them. Each
# node knows its size when it is made, and where its children sit inside it
# (`_parts`). Drawing walks the tree once, with a stack rather than
# recursion, into a flat list of shapes in the picture's own coordinates
# (`_pll_flatten`). That list is what is rendered as SVG, what `rotate`
# measures its box from, and what `==` compares: two images are equal when
# they draw the same shapes, in the same places, in the same colours.
#
# This module is loaded into Pyodide after the bootstrap (`bootstrap/`).
# The install step then copies the public names into each session's
# globals, so a beginner can write `circle(50, "solid", "red")` with no
# import (matching the HtDP/Pyret experience).

import base64 as _pll_img_b64
import heapq as _pll_img_heapq
import math as _math
import numbers as _pll_img_numbers
import os as _pll_img_os
import re as _pll_img_re
import sys as _pll_img_sys
import unicodedata as _pll_img_unicodedata


# -----------------------------------------------------------------------------
# Colours
# -----------------------------------------------------------------------------

#: Every named colour in CSS Color 4 - the names SVG accepts - with its
#: value, so `"red"` and `(255, 0, 0)` are the same colour to `==`. There are
#: 148 names; the count is asserted by the smoke tests, so dropping one fails
#: loudly rather than rejecting a colour that works.
_PLL_CSS_COLORS = {}
_pll_color_words = """
    aliceblue f0f8ff  antiquewhite faebd7  aqua 00ffff  aquamarine 7fffd4
    azure f0ffff  beige f5f5dc  bisque ffe4c4  black 000000
    blanchedalmond ffebcd  blue 0000ff  blueviolet 8a2be2  brown a52a2a
    burlywood deb887  cadetblue 5f9ea0  chartreuse 7fff00  chocolate d2691e
    coral ff7f50  cornflowerblue 6495ed  cornsilk fff8dc  crimson dc143c
    cyan 00ffff  darkblue 00008b  darkcyan 008b8b  darkgoldenrod b8860b
    darkgray a9a9a9  darkgreen 006400  darkgrey a9a9a9  darkkhaki bdb76b
    darkmagenta 8b008b  darkolivegreen 556b2f  darkorange ff8c00
    darkorchid 9932cc  darkred 8b0000  darksalmon e9967a
    darkseagreen 8fbc8f  darkslateblue 483d8b  darkslategray 2f4f4f
    darkslategrey 2f4f4f  darkturquoise 00ced1  darkviolet 9400d3
    deeppink ff1493  deepskyblue 00bfff  dimgray 696969  dimgrey 696969
    dodgerblue 1e90ff  firebrick b22222  floralwhite fffaf0
    forestgreen 228b22  fuchsia ff00ff  gainsboro dcdcdc  ghostwhite f8f8ff
    gold ffd700  goldenrod daa520  gray 808080  green 008000
    greenyellow adff2f  grey 808080  honeydew f0fff0  hotpink ff69b4
    indianred cd5c5c  indigo 4b0082  ivory fffff0  khaki f0e68c
    lavender e6e6fa  lavenderblush fff0f5  lawngreen 7cfc00
    lemonchiffon fffacd  lightblue add8e6  lightcoral f08080
    lightcyan e0ffff  lightgoldenrodyellow fafad2  lightgray d3d3d3
    lightgreen 90ee90  lightgrey d3d3d3  lightpink ffb6c1
    lightsalmon ffa07a  lightseagreen 20b2aa  lightskyblue 87cefa
    lightslategray 778899  lightslategrey 778899  lightsteelblue b0c4de
    lightyellow ffffe0  lime 00ff00  limegreen 32cd32  linen faf0e6
    magenta ff00ff  maroon 800000  mediumaquamarine 66cdaa
    mediumblue 0000cd  mediumorchid ba55d3  mediumpurple 9370db
    mediumseagreen 3cb371  mediumslateblue 7b68ee  mediumspringgreen 00fa9a
    mediumturquoise 48d1cc  mediumvioletred c71585  midnightblue 191970
    mintcream f5fffa  mistyrose ffe4e1  moccasin ffe4b5  navajowhite ffdead
    navy 000080  oldlace fdf5e6  olive 808000  olivedrab 6b8e23
    orange ffa500  orangered ff4500  orchid da70d6  palegoldenrod eee8aa
    palegreen 98fb98  paleturquoise afeeee  palevioletred db7093
    papayawhip ffefd5  peachpuff ffdab9  peru cd853f  pink ffc0cb
    plum dda0dd  powderblue b0e0e6  purple 800080  rebeccapurple 663399
    red ff0000  rosybrown bc8f8f  royalblue 4169e1  saddlebrown 8b4513
    salmon fa8072  sandybrown f4a460  seagreen 2e8b57  seashell fff5ee
    sienna a0522d  silver c0c0c0  skyblue 87ceeb  slateblue 6a5acd
    slategray 708090  slategrey 708090  snow fffafa  springgreen 00ff7f
    steelblue 4682b4  tan d2b48c  teal 008080  thistle d8bfd8
    tomato ff6347  turquoise 40e0d0  violet ee82ee  wheat f5deb3
    white ffffff  whitesmoke f5f5f5  yellow ffff00  yellowgreen 9acd32
""".split()
for _pll_i in range(0, len(_pll_color_words), 2):
    _pll_hex = _pll_color_words[_pll_i + 1]
    _PLL_CSS_COLORS[_pll_color_words[_pll_i]] = (
        int(_pll_hex[0:2], 16),
        int(_pll_hex[2:4], 16),
        int(_pll_hex[4:6], 16),
    )
del _pll_color_words, _pll_i, _pll_hex
_PLL_CSS_COLOR_NAMES = frozenset(_PLL_CSS_COLORS)

#: A colour *name*, once spaces, hyphens and underscores are taken out:
#: shaped like a word, and then checked against the list above.
_PLL_COLOR_NAME_RE = _pll_img_re.compile(r"^[a-z]+$")
_PLL_COLOR_HEX_RE = _pll_img_re.compile(r"^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$")
_PLL_COLOR_FN_RE = _pll_img_re.compile(r"^(rgba?|hsla?)\s*\((.*)\)$", _pll_img_re.S)
#: One argument of `rgb(...)` or `hsl(...)`: a number, maybe with a unit.
_PLL_COLOR_ARG_RE = _pll_img_re.compile(
    r"^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg)?$"
)

_PLL_MODES = ("solid", "outline")


class _Paint:
    """A colour as it is drawn: its CSS, its opacity, and what `==` compares.

    Made from what the student wrote when the shape is made, so a list of
    numbers changed afterwards changes nothing already drawn. The CSS is
    always written by PLL - a name from the list above, or `#rrggbb` - so
    nothing of the student's string reaches the SVG.
    """

    __slots__ = ("css", "alpha", "key")

    def __init__(self, css, rgb, alpha):
        self.css = css
        self.alpha = alpha
        # `currentColor` is whatever colour the text around it is, which is
        # the same as no other colour.
        self.key = (tuple(rgb) if rgb is not None else (-1, -1, -1)) + (round(alpha, 4),)


def _pll_hex_css(rgb):
    return "#%02x%02x%02x" % tuple(rgb)


_PLL_TRANSPARENT = _Paint("none", (0, 0, 0), 0.0)
_PLL_BLACK = _Paint("black", (0, 0, 0), 1.0)
_PLL_WHITE = _Paint("white", (255, 255, 255), 1.0)


#: Filled in at the end of this module, from the functions themselves, so
#: a message can say "the 3rd argument (mode)" and show the whole contract
#: without a second list of parameter names to keep in step.
_PLL_PARAMS = {}


def _pll_where(who, param):
    """" (the 3rd argument)", or "" when the position is not known."""
    names = _PLL_PARAMS.get(who)
    if not names or param not in names:
        return ""
    return " (the %s argument)" % _pll_ordinal(names.index(param))


def _pll_contract(who):
    """" The arguments are: rectangle(width, height, mode, color)." """
    names = _PLL_PARAMS.get(who)
    # Only worth showing when there are enough arguments to get lost
    # among; `frame(image)` explains itself.
    if not names or len(names) < 3:
        return ""
    return " The arguments are: %s(%s)." % (who, ", ".join(names))


def _pll_check_image(value, who, index):
    """One argument of a combining function.

    Checked when the function is called, so `beside(a, "austria")` fails
    there, naming `beside` and the argument, rather than later inside the
    rendering code - after the broken picture has been displayed - with
    "'str' object has no attribute 'width'".
    """
    if isinstance(value, Image):
        return value
    raise TypeError(
        "%s's %s argument is %s, not an image."
        % (who, _pll_ordinal(index), _pll_describe(value))
    )


def _pll_check_images(images, who, offset=0, least=0):
    """Every image argument of a combining function.

    `offset` is how many arguments come before them, so `beside_align`
    counts its images from the second position.
    """
    if len(images) == 1 and isinstance(images[0], (list, tuple)):
        raise TypeError(
            "%s takes the images themselves, not a list of them: "
            "write %s(first, second) rather than %s([first, second])."
            % (who, who, who)
        )
    if len(images) < least:
        raise TypeError(
            "%s needs at least one image to put together, like %s(first, second)."
            % (who, who)
        )
    for index, value in enumerate(images):
        _pll_check_image(value, who, index + offset)
    return images


def _pll_real(value):
    """Whether `value` is a number - numpy's too - and not a bool."""
    return isinstance(value, _pll_img_numbers.Real) and not isinstance(value, bool)


def _pll_check_number(value, who, param):
    """A number, which may be negative - an offset or an angle - as a float.

    NaN and the infinities are numbers to Python and nothing to draw with;
    let through, they failed much later, in Python's words.
    """
    if not _pll_real(value):
        raise TypeError(
            "%s's `%s`%s must be a number, but it is %s.%s"
            % (who, param, _pll_where(who, param), _pll_describe(value), _pll_contract(who))
        )
    try:
        number = float(value)
    except OverflowError:
        raise ValueError(
            "%s's `%s`%s is a number too big to draw with.%s"
            % (who, param, _pll_where(who, param), _pll_contract(who))
        ) from None
    if number != number:
        raise ValueError(
            "%s's `%s`%s is NaN (\"not a number\"), which cannot be drawn with.%s"
            % (who, param, _pll_where(who, param), _pll_contract(who))
        )
    if number in (_math.inf, -_math.inf):
        raise ValueError(
            "%s's `%s`%s cannot be infinite, but it is %s.%s"
            % (who, param, _pll_where(who, param), _pll_number(number), _pll_contract(who))
        )
    return number


def _pll_check_size(value, who, param, least=0):
    """A size in pixels: a number, and never negative.

    A string size (`rectangle("20", 20, ...)`) and a negative one were both
    accepted, and drew the wrong thing or nothing at all without a word.
    """
    number = _pll_check_number(value, who, param)
    if number < least:
        raise ValueError(
            "%s's `%s`%s cannot be %s, but it is %s.%s"
            % (
                who,
                param,
                _pll_where(who, param),
                "negative" if least == 0 else "less than %s" % _pll_number(least),
                _pll_number(value),
                _pll_contract(who),
            )
        )
    return number


def _pll_check_positive(value, who, param):
    """A number that has to be more than zero, like a scale factor."""
    number = _pll_check_number(value, who, param)
    if number <= 0:
        raise ValueError(
            "%s's `%s`%s has to be more than 0, but it is %s.%s"
            % (who, param, _pll_where(who, param), _pll_number(value), _pll_contract(who))
        )
    return number


def _pll_check_count(value, who, param, least):
    """How many of something: a whole number, at least `least`."""
    if isinstance(value, _pll_img_numbers.Integral) and not isinstance(value, bool):
        count = int(value)
    elif isinstance(value, float) and value.is_integer():
        raise TypeError(
            "%s's `%s`%s has to be a whole number, but it is %s: write %d.%s"
            % (who, param, _pll_where(who, param), value, int(value), _pll_contract(who))
        )
    else:
        _pll_check_number(value, who, param)
        raise TypeError(
            "%s's `%s`%s has to be a whole number, but it is %s.%s"
            % (who, param, _pll_where(who, param), _pll_describe(value), _pll_contract(who))
        )
    if count < least:
        raise ValueError(
            "%s's `%s`%s cannot be less than %d, but it is %d.%s"
            % (who, param, _pll_where(who, param), least, count, _pll_contract(who))
        )
    return count


def _pll_check_order(first, second, who, param):
    """The two arguments the other way round.

    `rotate(image, 45)` fails inside the arithmetic with "float() argument
    must be a string or a real number, not '_Frame'", which names an
    internal class and not the mistake.
    """
    if isinstance(first, Image) and _pll_real(second):
        raise TypeError(
            "%s takes the `%s` first, then the image: write %s(%s, image)."
            % (who, param, who, _pll_number(second))
        )


def _pll_check_color(color, who):
    """The colour `color` names, as a `_Paint`; anything else is an error.

    SVG ignores a paint value it cannot parse, so an unchecked
    `rectangle(30, 40, "solid", 50)` would draw an invisible rectangle and
    say nothing at all. Checked here, at construction, rather than when the
    picture renders, so the error points at the line that made the mistake.

    A *name* is checked against the CSS colours, which are the names SVG
    accepts, so a misspelling is caught rather than drawn as nothing. The
    list is the whole of CSS Color 4 and its length is asserted by the
    tests: rejecting a colour that works would be worse than the typo.
    """
    if isinstance(color, str):
        return _pll_color_string(color, who)
    if isinstance(color, (tuple, list)) and len(color) in (3, 4):
        return _pll_color_numbers(list(color), who)
    raise ValueError(_pll_not_a_colour(who, color))


def _pll_color_string(color, who):
    text = color.strip().lower()
    if text in _PLL_CSS_COLORS:
        return _Paint(text, _PLL_CSS_COLORS[text], 1.0)
    if text in ("transparent", "none"):
        return _PLL_TRANSPARENT
    if text == "currentcolor":
        return _Paint("currentColor", None, 1.0)
    found = _PLL_COLOR_HEX_RE.match(text)
    if found:
        digits = found.group(1)
        if len(digits) <= 4:
            digits = "".join(d * 2 for d in digits)
        rgb = tuple(int(digits[i:i + 2], 16) for i in (0, 2, 4))
        alpha = int(digits[6:8], 16) / 255.0 if len(digits) == 8 else 1.0
        return _Paint(_pll_hex_css(rgb), rgb, alpha)
    found = _PLL_COLOR_FN_RE.match(text)
    if found:
        return _pll_color_function(found.group(1), found.group(2), color, who)
    # "light blue", "light-blue": CSS writes every name as one word.
    squeezed = _pll_img_re.sub(r"[\s_-]+", "", text)
    if _PLL_COLOR_NAME_RE.match(squeezed):
        raise ValueError(_pll_unknown_colour(who, color, squeezed))
    raise ValueError(_pll_not_a_colour(who, color))


def _pll_color_function(kind, inner, color, who):
    """`rgb(...)`, `rgba(...)`, `hsl(...)` or `hsla(...)`, read strictly.

    Only numbers, with `%` or `deg` where CSS allows them, separated as CSS
    separates them: by commas, or by spaces with the opacity after a `/`.
    """
    example = '"rgb(255, 0, 0)"' if kind.startswith("rgb") else '"hsl(0, 100%, 50%)"'
    bad = ValueError(
        "%s's `color`%s is %s, which is not a color. Write %s(...) with three "
        "numbers, like %s."
        % (who, _pll_where(who, "color"), _pll_describe(color), kind.rstrip("a"), example)
    )
    inner = inner.strip()
    if "," in inner:
        parts = [part.strip() for part in inner.split(",")]
        alpha = parts.pop() if len(parts) == 4 else None
    else:
        main, slash, alpha = inner.partition("/")
        parts = main.split()
        alpha = alpha.strip() if slash else None
    if len(parts) != 3:
        raise bad
    args = [_PLL_COLOR_ARG_RE.match(part) for part in parts + ([alpha] if alpha is not None else [])]
    if None in args:
        raise bad
    values = [(float(arg.group(1)), arg.group(2)) for arg in args]

    def out_of_range(i, low, high, unit=""):
        return ValueError(
            "%s's `color`%s: the %s part runs from %s%s to %s%s, but it is %s%s."
            % (
                who,
                _pll_where(who, "color"),
                ("red green blue" if kind.startswith("rgb") else "hue saturation lightness").split()[i]
                if i < 3
                else "opacity",
                low, unit, high, unit,
                _pll_number(values[i][0]),
                values[i][1] or "",
            )
        )

    if kind.startswith("rgb"):
        rgb = []
        for i, (number, unit) in enumerate(values[:3]):
            if unit == "deg":
                raise bad
            if unit == "%":
                if not 0 <= number <= 100:
                    raise out_of_range(i, 0, 100, "%")
                number = number * 255 / 100
            elif not 0 <= number <= 255:
                raise out_of_range(i, 0, 255)
            rgb.append(int(round(number)))
    else:
        (hue, hue_unit), (sat, sat_unit), (light, light_unit) = values[:3]
        if hue_unit == "%" or sat_unit == "deg" or light_unit == "deg":
            raise bad
        for i, value in ((1, sat), (2, light)):
            if not 0 <= value <= 100:
                raise out_of_range(i, 0, 100, "%")
        rgb = _pll_hsl_to_rgb(hue % 360, sat / 100, light / 100)
    opacity = 1.0
    if alpha is not None:
        number, unit = values[3]
        if unit == "deg":
            raise bad
        opacity = number / 100 if unit == "%" else number
        if not 0 <= opacity <= 1:
            raise out_of_range(3, 0, 100, "%") if unit == "%" else out_of_range(3, 0, 1)
    return _Paint(_pll_hex_css(rgb), rgb, opacity)


def _pll_hsl_to_rgb(hue, sat, light):
    """CSS's conversion, to whole numbers from 0 to 255."""

    def channel(n):
        k = (n + hue / 30) % 12
        a = sat * min(light, 1 - light)
        return light - a * max(-1, min(k - 3, 9 - k, 1))

    return tuple(int(round(channel(n) * 255)) for n in (0, 8, 4))


def _pll_color_numbers(parts, who):
    """`(red, green, blue)` or `(red, green, blue, opacity)`.

    The opacity is written either way, and which is told by its type: a
    whole number runs from 0 to 255 like the others, a fraction from 0.0 to
    1.0. So `(255, 0, 0, 128)` and `(255, 0, 0, 0.5)` are both half see-
    through, and `(255, 0, 0, 1)` is almost invisible where `1.0` is solid.
    """
    names = ("red", "green", "blue", "opacity")
    for part in parts:
        if not _pll_real(part):
            raise ValueError(
                "%s's `color`%s has a part that is not a number: %s."
                % (who, _pll_where(who, "color"), _pll_describe(part))
            )
    rgb = []
    for i, part in enumerate(parts[:3]):
        if not 0 <= part <= 255:
            raise ValueError(
                "%s's `color`%s: the %s part runs from 0 to 255, but it is %s."
                % (who, _pll_where(who, "color"), names[i], _pll_number(part))
            )
        rgb.append(int(round(float(part))))
    alpha = 1.0
    if len(parts) == 4:
        part = parts[3]
        if isinstance(part, _pll_img_numbers.Integral):
            if not 0 <= part <= 255:
                raise ValueError(
                    "%s's `color`%s: the opacity part runs from 0 to 255 as a whole "
                    "number, or from 0.0 to 1.0 as a fraction, but it is %s."
                    % (who, _pll_where(who, "color"), _pll_number(part))
                )
            alpha = int(part) / 255.0
        else:
            if not 0 <= part <= 1:
                raise ValueError(
                    "%s's `color`%s: the opacity part is a fraction from 0.0 to 1.0 "
                    "(or a whole number from 0 to 255), but it is %s."
                    % (who, _pll_where(who, "color"), _pll_number(part))
                )
            alpha = float(part)
    return _Paint(_pll_hex_css(rgb), rgb, alpha)


def _pll_not_a_colour(who, color):
    """The one wording for "that is not a colour", wherever it is noticed."""
    return (
        "%s's `color`%s is %s, which is not a color. Use a name like \"red\", "
        "a hex code like \"#ff0000\", or (red, green, blue) numbers from 0 to 255."
        % (who, _pll_where(who, "color"), _pll_describe(color))
    )


def _pll_unknown_colour(who, color, squeezed):
    """A word that is shaped like a colour name and is not one."""
    if squeezed in _PLL_CSS_COLORS:
        suggestion = squeezed
    else:
        suggestion = _pll_closest_name(squeezed, _PLL_CSS_COLOR_NAMES)
    return "%s's `color`%s is %s, which is not a color name PLL knows.%s" % (
        who,
        _pll_where(who, "color"),
        _pll_describe(color),
        ' Did you mean "%s"?' % suggestion
        if suggestion is not None
        else ' Use a name like "red", a hex code like "#ff0000", or '
        "(red, green, blue) numbers from 0 to 255.",
    )


def _pll_check_mode(mode, who):
    """`solid` or `outline`, and nothing else.

    Anything else is an error, as a bad colour is: falling through to solid
    would quietly fill the shape for a misspelled "outilne".
    """
    if mode not in _PLL_MODES:
        raise ValueError(
            "%s's `mode`%s should be \"solid\" or \"outline\", but it is %s.%s"
            % (who, _pll_where(who, "mode"), _pll_describe(mode), _pll_contract(who))
        )
    return mode


def _pll_px(value):
    """A size in whole pixels, with trigonometry's rounding error removed.

    Rounded before the ceiling. A hexagon of side 40 is exactly 80 across,
    but the cosines that build it give 80.00000000000001, and `ceil` turned
    that into an 81-pixel box with a blank column down one side.

    Zero stays zero: `empty_image` is 0x0, and `beside` and friends do
    arithmetic with that. Only an `<svg>` viewport needs a floor of 1, and
    `to_svg` applies it there.
    """
    return int(_math.ceil(round(value, 9)))


# -----------------------------------------------------------------------------
# Geometry: transforms, flattening, clipping
# -----------------------------------------------------------------------------
#
# A transform is SVG's `matrix(a, b, c, d, e, f)`: a point (x, y) goes to
# (a*x + c*y + e, b*x + d*y + f). PLL only ever makes similarities - moves,
# turns, flips and even scaling - but nothing below relies on it.

_PLL_IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _pll_translate(dx, dy):
    return (1.0, 0.0, 0.0, 1.0, float(dx), float(dy))


def _pll_compose(outer, inner):
    """The transform that applies `inner`, then `outer`."""
    a, b, c, d, e, f = outer
    a2, b2, c2, d2, e2, f2 = inner
    return (
        a * a2 + c * b2,
        b * a2 + d * b2,
        a * c2 + c * d2,
        b * c2 + d * d2,
        a * e2 + c * f2 + e,
        b * e2 + d * f2 + f,
    )


def _pll_apply(m, x, y):
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def _pll_corners(m, w, h):
    """The corners of a `w` x `h` box drawn with `m`, in drawing order."""
    return (_pll_apply(m, 0, 0), _pll_apply(m, w, 0), _pll_apply(m, w, h), _pll_apply(m, 0, h))


def _pll_bounds(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def _pll_area(points):
    """Twice the signed area; positive when the points turn one way."""
    total = 0.0
    n = len(points)
    for i in range(n):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % n]
        total += x1 * y2 - x2 * y1
    return total


def _pll_convex_and(subject, clipper):
    """The part of convex polygon `subject` inside convex polygon `clipper`.

    Sutherland-Hodgman, edge by edge. Empty when they do not meet.
    """
    turn = 1.0 if _pll_area(clipper) >= 0 else -1.0
    out = list(subject)
    n = len(clipper)
    for i in range(n):
        if not out:
            break
        ax, ay = clipper[i]
        bx, by = clipper[(i + 1) % n]

        def side(p):
            return turn * ((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax))

        given = out
        out = []
        prev = given[-1]
        prev_side = side(prev)
        for cur in given:
            cur_side = side(cur)
            if cur_side >= -1e-9:
                if prev_side < -1e-9:
                    t = prev_side / (prev_side - cur_side)
                    out.append((prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])))
                out.append(cur)
            elif prev_side >= -1e-9:
                t = prev_side / (prev_side - cur_side)
                out.append((prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])))
            prev, prev_side = cur, cur_side
    kept = []
    for p in out:
        if not kept or abs(p[0] - kept[-1][0]) > 1e-9 or abs(p[1] - kept[-1][1]) > 1e-9:
            kept.append(p)
    if len(kept) > 1 and abs(kept[0][0] - kept[-1][0]) <= 1e-9 and abs(kept[0][1] - kept[-1][1]) <= 1e-9:
        kept.pop()
    return tuple(kept) if len(kept) >= 3 else ()


def _pll_inside(polygon, points):
    """Whether every one of `points` is inside convex `polygon`."""
    turn = 1.0 if _pll_area(polygon) >= 0 else -1.0
    n = len(polygon)
    for i in range(n):
        ax, ay = polygon[i]
        bx, by = polygon[(i + 1) % n]
        for px, py in points:
            if turn * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < -1e-6:
                return False
    return True


# An item is one shape, ready to draw: its kind, the convex polygon it is
# clipped to (or None), and the kind's own geometry, all in the coordinates
# of the picture being drawn:
#
#   ("poly", clip, points, mode, paint)
#   ("ellipse", clip, cx, cy, rx, ry, degrees, mode, paint)  rx along degrees
#   ("line", clip, x1, y1, x2, y2, paint)
#   ("text", clip, matrix, text, size, width, height, paint)
#   ("bitmap", clip, matrix, width, height, loaded_image)
#   ("svg", clip, matrix, width, height, markup)
#   ("box", clip, points)    nothing drawn: a box `rotate` measures, as 2htdp
#                            counts a crop's own edges


def _pll_raw_extent(item):
    """The box an item covers, ignoring its clip."""
    kind = item[0]
    if kind == "poly" or kind == "box":
        return _pll_bounds(item[2])
    if kind == "ellipse":
        _, _, cx, cy, rx, ry, degrees = item[:7]
        rad = _math.radians(degrees)
        cos, sin = _math.cos(rad), _math.sin(rad)
        ex = _math.hypot(rx * cos, ry * sin)
        ey = _math.hypot(rx * sin, ry * cos)
        return (cx - ex, cy - ey, cx + ex, cy + ey)
    if kind == "line":
        x0, y0, x1, y1 = _pll_bounds((item[2:4], item[4:6]))
        # A line is at least a pixel across, as its own box is.
        if x1 - x0 < 1:
            mid = (x0 + x1) / 2
            x0, x1 = mid - 0.5, mid + 0.5
        if y1 - y0 < 1:
            mid = (y0 + y1) / 2
            y0, y1 = mid - 0.5, mid + 0.5
        return (x0, y0, x1, y1)
    m = item[2]
    w, h = (item[5], item[6]) if kind == "text" else (item[3], item[4])
    return _pll_bounds(_pll_corners(m, w, h))


def _pll_extent(item):
    """The box an item covers, within its clip."""
    x0, y0, x1, y1 = _pll_raw_extent(item)
    clip = item[1]
    if clip:
        cx0, cy0, cx1, cy1 = _pll_bounds(clip)
        x0, y0, x1, y1 = max(x0, cx0), max(y0, cy0), min(x1, cx1), min(y1, cy1)
    return (x0, y0, max(x0, x1), max(y0, y1))


def _pll_settle(item):
    """`item` with a clip only where one cuts something off, or None.

    A shape wholly inside its clip needs none, and one wholly outside draws
    nothing - so a picture placed inside a scene draws, and compares, as it
    would on its own.
    """
    clip = item[1]
    if clip is None:
        return item
    if not clip:
        return None
    x0, y0, x1, y1 = _pll_raw_extent(item)
    cx0, cy0, cx1, cy1 = _pll_bounds(clip)
    if x0 > cx1 or x1 < cx0 or y0 > cy1 or y1 < cy0:
        return None
    if _pll_inside(clip, ((x0, y0), (x1, y0), (x1, y1), (x0, y1))):
        return item[:1] + (None,) + item[2:]
    return item


def _pll_flatten(image, m=_PLL_IDENTITY):
    """Every shape `image` draws, bottom first, drawn with `m`.

    A stack rather than recursion: a picture built in a loop of a thousand
    `beside`s is a thousand levels deep, past Python's recursion limit.
    """
    out = []
    stack = [(image, m, None)]
    while stack:
        node, m, clip = stack.pop()
        parts = node._parts()
        if parts is None:
            for item in node._items(m, clip):
                item = _pll_settle(item)
                if item is not None:
                    out.append(item)
            continue
        # Pushed last first, so the bottom part is drawn first.
        for child, local, local_clip in reversed(parts):
            child_m = m if local is None else _pll_compose(m, local)
            child_clip = clip
            if local_clip is not None:
                region = tuple(_pll_apply(m, x, y) for x, y in local_clip)
                child_clip = region if clip is None else _pll_convex_and(clip, region)
            stack.append((child, child_m, child_clip))
    return out


# -----------------------------------------------------------------------------
# Comparing what two images draw
# -----------------------------------------------------------------------------

def _pll_r(value):
    """A position or a size as `==` compares it: to a hundredth of a pixel."""
    value = round(value, 2)
    return 0.0 if value == 0 else value


def _pll_point_key(p):
    return (_pll_r(p[0]), _pll_r(p[1]))


def _pll_polygon_key(points):
    """The same polygon whichever corner it starts at and whichever way round."""
    pts = []
    for p in points:
        p = _pll_point_key(p)
        if not pts or pts[-1] != p:
            pts.append(p)
    while len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if not pts:
        return ()
    lowest = min(pts)
    best = None
    for seq in (pts, pts[::-1]):
        for i, p in enumerate(seq):
            if p == lowest:
                candidate = tuple(seq[i:] + seq[:i])
                if best is None or candidate < best:
                    best = candidate
    return best


def _pll_item_key(item):
    """What `==` compares of one item."""
    kind = item[0]
    if kind == "poly":
        shape = ("poly", item[3], item[4].key, _pll_polygon_key(item[2]))
    elif kind == "ellipse":
        _, _, cx, cy, rx, ry, degrees, mode, paint = item
        big, small = max(rx, ry), min(rx, ry)
        if big - small < 0.005:
            axis = (0.0, 0.0)
        else:
            rad = _math.radians(degrees if rx >= ry else degrees + 90)
            ax, ay = _pll_r(big * _math.cos(rad)), _pll_r(big * _math.sin(rad))
            # A diameter, so either end names it.
            axis = (ax, ay) if ax > 0 or (ax == 0 and ay > 0) else (_pll_r(-ax), _pll_r(-ay))
        shape = ("ellipse", mode, paint.key, _pll_r(cx), _pll_r(cy), _pll_r(big), _pll_r(small), axis)
    elif kind == "line":
        ends = sorted((_pll_point_key(item[2:4]), _pll_point_key(item[4:6])))
        shape = ("line", item[6].key, tuple(ends))
    else:
        m = item[2]
        w, h = (item[5], item[6]) if kind == "text" else (item[3], item[4])
        corners = tuple(
            _pll_point_key(p) for p in (_pll_apply(m, 0, 0), _pll_apply(m, w, 0), _pll_apply(m, 0, h))
        )
        if kind == "text":
            shape = ("text", item[7].key, item[3], corners)
        elif kind == "bitmap":
            shape = ("bitmap", corners, item[5]._media_type, item[5]._data)
        else:
            shape = ("svg", corners, item[5])
    return (shape, _pll_polygon_key(item[1]) if item[1] else ())


def _pll_visible(item):
    kind = item[0]
    if kind == "box":
        return False
    if kind in ("poly", "ellipse"):
        return item[-1].alpha > 0
    if kind == "line":
        return item[6].alpha > 0
    if kind == "text":
        return item[7].alpha > 0 and item[3] != ""
    return True


def _pll_canonical(items):
    """The items as `==` compares them, in an order fixed by what they draw.

    Painting order matters only where two shapes overlap, so `beside(a, b)`
    and an `overlay_xy` that puts the same two side by side draw the same
    thing in different orders. Shapes that do not overlap may be taken in
    either order; of those free to go next, the least is taken, which gives
    every way of drawing the same picture the same list.
    """
    keys = []
    boxes = []
    for item in items:
        if _pll_visible(item):
            keys.append(_pll_item_key(item))
            boxes.append(_pll_extent(item))
    n = len(keys)
    successors = [[] for _ in range(n)]
    waiting = [0] * n
    # Sweep across by left edge, so only shapes that could meet are tried.
    by_left = sorted(range(n), key=lambda i: boxes[i][0])
    for at, i in enumerate(by_left):
        x0, y0, x1, y1 = boxes[i]
        for j in by_left[at + 1:]:
            bx0, by0, bx1, by1 = boxes[j]
            if bx0 >= x1 - 0.005:
                break
            if min(y1, by1) - max(y0, by0) > 0.005 and min(x1, bx1) - max(x0, bx0) > 0.005:
                lower, upper = (i, j) if i < j else (j, i)
                successors[lower].append(upper)
                waiting[upper] += 1
    ready = [(keys[i], i) for i in range(n) if waiting[i] == 0]
    _pll_img_heapq.heapify(ready)
    out = []
    while ready:
        key, i = _pll_img_heapq.heappop(ready)
        out.append(key)
        for j in successors[i]:
            waiting[j] -= 1
            if waiting[j] == 0:
                _pll_img_heapq.heappush(ready, (keys[j], j))
    return tuple(out)


# -----------------------------------------------------------------------------
# Drawing as SVG
# -----------------------------------------------------------------------------

#: Per interpreter, so two pictures shown in the same panel - one from
#: before Python was restarted - never share an id.
_PLL_SVG_ID_PREFIX = "pll" + _pll_img_os.urandom(3).hex()
_pll_svg_ids = 0


def _pll_svg_id(kind):
    global _pll_svg_ids
    _pll_svg_ids += 1
    return "%s%s%d" % (_PLL_SVG_ID_PREFIX, kind, _pll_svg_ids)


def _pll_n(value):
    """A number for an SVG attribute: to a hundredth, without trailing zeros."""
    value = round(value, 2)
    if value == int(value):
        return "%d" % int(value)
    return ("%.2f" % value).rstrip("0")


def _pll_points(points):
    return " ".join("%s,%s" % (_pll_n(x), _pll_n(y)) for x, y in points)


def _pll_paint(paint, attribute):
    text = ' %s="%s"' % (attribute, paint.css)
    if paint.alpha < 1:
        text += ' %s-opacity="%s"' % (attribute, ("%.3f" % paint.alpha).rstrip("0").rstrip(".") or "0")
    return text


def _pll_outline(paint):
    """The pen: 1 pixel, at any scale, as 2htdp's is."""
    return ' fill="none"%s stroke-width="1" stroke-miterlimit="10"' % _pll_paint(paint, "stroke")


def _pll_is_translation(m):
    return m[0] == 1 and m[1] == 0 and m[2] == 0 and m[3] == 1


def _pll_matrix(m):
    return "matrix(%s)" % " ".join(
        ("%.6f" % v).rstrip("0").rstrip(".") if i < 4 else _pll_n(v) for i, v in enumerate(m)
    )


def _pll_axis_rect(points):
    """(x, y, w, h) when the four points are an upright rectangle."""
    if len(points) != 4:
        return None
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = points
    if (abs(y0 - y1) < 1e-9 and abs(x1 - x2) < 1e-9 and abs(y2 - y3) < 1e-9 and abs(x3 - x0) < 1e-9) or (
        abs(x0 - x1) < 1e-9 and abs(y1 - y2) < 1e-9 and abs(x2 - x3) < 1e-9 and abs(y3 - y0) < 1e-9
    ):
        left, top, right, bottom = _pll_bounds(points)
        return (left, top, right - left, bottom - top)
    return None


def _pll_inset(points, d):
    """The polygon moved `d` inward along every edge, or None if it vanishes.

    So a 1-pixel pen centred on it lies just inside the shape: an outline
    stays within its box, and two outlined squares side by side each keep
    their own edge.
    """
    pts = []
    for p in points:
        if not pts or abs(p[0] - pts[-1][0]) > 1e-9 or abs(p[1] - pts[-1][1]) > 1e-9:
            pts.append(p)
    while len(pts) > 1 and abs(pts[0][0] - pts[-1][0]) <= 1e-9 and abs(pts[0][1] - pts[-1][1]) <= 1e-9:
        pts.pop()
    n = len(pts)
    if n < 3:
        return None
    area = _pll_area(pts)
    if abs(area) < 1e-9:
        return None
    turn = 1.0 if area > 0 else -1.0
    edges = []
    for i in range(n):
        (px, py), (qx, qy) = pts[i], pts[(i + 1) % n]
        dx, dy = qx - px, qy - py
        length = _math.hypot(dx, dy)
        nx, ny = -turn * dy / length, turn * dx / length
        edges.append((px + nx * d, py + ny * d, dx, dy))
    out = []
    for i in range(n):
        ax, ay, adx, ady = edges[i - 1]
        bx, by, bdx, bdy = edges[i]
        den = adx * bdy - ady * bdx
        if abs(den) < 1e-12 * max(1.0, _math.hypot(adx, ady) * _math.hypot(bdx, bdy)):
            out.append((bx, by))
            continue
        t = ((bx - ax) * bdy - (by - ay) * bdx) / den
        out.append((ax + t * adx, ay + t * ady))
    inner = _pll_area(out)
    if inner * area <= 0 or abs(inner) < 1e-6:
        return None
    for i in range(n):
        dx = out[(i + 1) % n][0] - out[i][0]
        dy = out[(i + 1) % n][1] - out[i][1]
        if dx * edges[i][2] + dy * edges[i][3] <= 0:
            return None
    return out


def _pll_svg_poly(item):
    _, _, points, mode, paint = item
    if mode == "outline":
        rect = _pll_axis_rect(points)
        if rect is not None and rect[2] > 1 and rect[3] > 1:
            x, y, w, h = rect
            return '<rect x="%s" y="%s" width="%s" height="%s"%s/>' % (
                _pll_n(x + 0.5), _pll_n(y + 0.5), _pll_n(w - 1), _pll_n(h - 1), _pll_outline(paint),
            )
        inner = None if rect is not None else _pll_inset(points, 0.5)
        if inner is not None:
            return '<polygon points="%s"%s/>' % (_pll_points(inner), _pll_outline(paint))
        # Too small to have an inside: the pen fills it.
    rect = _pll_axis_rect(points)
    if rect is not None:
        return '<rect x="%s" y="%s" width="%s" height="%s"%s/>' % (
            _pll_n(rect[0]), _pll_n(rect[1]), _pll_n(rect[2]), _pll_n(rect[3]), _pll_paint(paint, "fill"),
        )
    return '<polygon points="%s"%s/>' % (_pll_points(points), _pll_paint(paint, "fill"))


def _pll_svg_ellipse(item):
    _, _, cx, cy, rx, ry, degrees, mode, paint = item
    style = _pll_paint(paint, "fill")
    if mode == "outline" and rx > 0.5 and ry > 0.5:
        rx, ry = rx - 0.5, ry - 0.5
        style = _pll_outline(paint)
    if abs(rx - ry) < 1e-9:
        return '<circle cx="%s" cy="%s" r="%s"%s/>' % (_pll_n(cx), _pll_n(cy), _pll_n(rx), style)
    turned = ""
    if abs(degrees % 180) > 1e-9:
        turned = ' transform="rotate(%s %s %s)"' % (_pll_n(degrees), _pll_n(cx), _pll_n(cy))
    return '<ellipse cx="%s" cy="%s" rx="%s" ry="%s"%s%s/>' % (
        _pll_n(cx), _pll_n(cy), _pll_n(rx), _pll_n(ry), turned, style,
    )


def _pll_svg_line(item):
    _, _, x1, y1, x2, y2, paint = item
    if abs(x1 - x2) < 1e-9 and abs(y1 - y2) < 1e-9:
        return ""
    return '<line x1="%s" y1="%s" x2="%s" y2="%s"%s stroke-width="1"/>' % (
        _pll_n(x1), _pll_n(y1), _pll_n(x2), _pll_n(y2), _pll_paint(paint, "stroke"),
    )


#: Text is set in a monospace font, whose every character is the same width,
#: so its size is known rather than guessed; `textLength` holds it to that
#: width whichever monospace font the viewer has.
_PLL_TEXT_ADVANCE = 0.6
_PLL_TEXT_HEIGHT = 1.2
_PLL_TEXT_BASELINE = 0.92


def _pll_text_cells(text):
    """How many character cells `text` takes: wide characters two, accents none."""
    cells = 0
    for ch in text:
        if _pll_img_unicodedata.combining(ch) or _pll_img_unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            continue
        cells += 2 if _pll_img_unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return cells


def _pll_svg_text(item):
    _, _, m, text, size, w, h, paint = item
    if w <= 0:
        return ""
    attrs = (
        'font-family="monospace" font-size="%s" textLength="%s" '
        'lengthAdjust="spacingAndGlyphs" xml:space="preserve"%s'
    ) % (_pll_n(size), _pll_n(w), _pll_paint(paint, "fill"))
    baseline = size * _PLL_TEXT_BASELINE
    if _pll_is_translation(m):
        return '<text x="%s" y="%s" %s>%s</text>' % (
            _pll_n(m[4]), _pll_n(m[5] + baseline), attrs, _pll_xml_escape(text),
        )
    return '<text x="0" y="%s" %s transform="%s">%s</text>' % (
        _pll_n(baseline), attrs, _pll_matrix(m), _pll_xml_escape(text),
    )


def _pll_placed(m):
    """Attributes that put something drawn at (0, 0) where `m` puts it."""
    if _pll_is_translation(m):
        return ' x="%s" y="%s"' % (_pll_n(m[4]), _pll_n(m[5]))
    return ' x="0" y="0" transform="%s"' % _pll_matrix(m)


def _pll_svg_markup(item):
    m, markup = item[2], item[5]
    if m == _PLL_IDENTITY:
        return markup
    return '<g transform="%s">%s</g>' % (_pll_matrix(m), markup)


def _pll_render(items):
    """The SVG elements that draw `items`, with whatever `<defs>` they need.

    A picture loaded once and used many times is embedded once and drawn
    with `<use>`; shapes that share a clip share one group.
    """
    uses = {}
    for item in items:
        if item[0] == "bitmap":
            uses[id(item[5])] = uses.get(id(item[5]), 0) + 1
    defs = []
    body = []
    shared = {}
    clip = None
    for item in items:
        kind = item[0]
        if kind == "box":
            continue
        if kind == "poly":
            markup = _pll_svg_poly(item) if item[4].alpha > 0 else ""
        elif kind == "ellipse":
            markup = _pll_svg_ellipse(item) if item[8].alpha > 0 else ""
        elif kind == "line":
            markup = _pll_svg_line(item) if item[6].alpha > 0 else ""
        elif kind == "text":
            markup = _pll_svg_text(item) if item[7].alpha > 0 else ""
        elif kind == "bitmap":
            picture = item[5]
            size = ' width="%s" height="%s" preserveAspectRatio="none"' % (_pll_n(item[3]), _pll_n(item[4]))
            if uses[id(picture)] == 1:
                markup = '<image%s%s href="%s"/>' % (_pll_placed(item[2]), size, picture._href())
            else:
                if id(picture) not in shared:
                    shared[id(picture)] = _pll_svg_id("i")
                    defs.append('<image id="%s"%s href="%s"/>' % (shared[id(picture)], size, picture._href()))
                markup = '<use href="#%s"%s/>' % (shared[id(picture)], _pll_placed(item[2]))
        else:
            markup = _pll_svg_markup(item)
        if not markup:
            continue
        if item[1] != clip:
            if clip is not None:
                body.append("</g>")
            clip = item[1]
            if clip is not None:
                cid = _pll_svg_id("c")
                defs.append('<clipPath id="%s"><polygon points="%s"/></clipPath>' % (cid, _pll_points(clip)))
                body.append('<g clip-path="url(#%s)">' % cid)
        body.append(markup)
    if clip is not None:
        body.append("</g>")
    return ("<defs>%s</defs>" % "".join(defs) if defs else "") + "".join(body)


# -----------------------------------------------------------------------------
# Image base class
# -----------------------------------------------------------------------------

class Image:
    """A picture: the type of everything `circle`, `beside`, `text`, ... make.

    Use it in annotations - `def badge(n: int) -> Image:` - and make pictures
    with the shape functions, not with `Image()` itself. Two images are `==`
    when they draw the same shapes in the same places in the same colours.
    """

    _w = 0.0
    _h = 0.0
    #: The flattened drawing and what `==` compares, worked out once each.
    _flat = None
    _key = None

    def __init__(self, *args, **kwargs):
        raise TypeError(
            "Image is the type of pictures, not a way to make one. Make a "
            'picture with a shape - circle(20, "solid", "red"), rectangle, '
            "text, ... - and put pictures together with beside, above and overlay."
        )

    @property
    def width(self):
        return self._w

    @property
    def height(self):
        return self._h

    def _parts(self):
        """`(child, transform, clip)` for each child, bottom first; None for a shape."""
        return None

    def _items(self, m, clip):
        """A shape's items, drawn with `m` and clipped to `clip`."""
        return ()

    def _drawing(self):
        if self._flat is None:
            self._flat = _pll_flatten(self)
        return self._flat

    def to_svg(self):
        # At least 1: an `<svg>` of zero width renders as nothing at all.
        w = max(1, _pll_px(self._w))
        h = max(1, _pll_px(self._h))
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" '
            'width="%d" height="%d" '
            'viewBox="0 0 %d %d" '
            'shape-rendering="geometricPrecision">%s</svg>'
        ) % (w, h, w, h, _pll_render(self._drawing()))

    def _pll_image_data(self):
        return {
            "type": "svg",
            "width": _pll_px(self._w),
            "height": _pll_px(self._h),
            "data": self.to_svg(),
        }

    def _pll_comparable(self):
        if self._key is None:
            self._key = (_pll_r(self._w), _pll_r(self._h), _pll_canonical(self._drawing()))
        return self._key

    def __eq__(self, other):
        if not isinstance(other, Image):
            return NotImplemented
        return self is other or self._pll_comparable() == other._pll_comparable()

    def __hash__(self):
        return hash(self._pll_comparable())

    # Nothing about an image changes, so a copy is the image itself - and
    # `deepcopy` would otherwise recurse down a deep picture.
    def __copy__(self):
        return self

    def __deepcopy__(self, memo):
        return self

    def __repr__(self):
        return "<Image %dx%d>" % (_pll_px(self._w), _pll_px(self._h))

    def __add__(self, other):
        """`a + b` on images, which looks plausible and is not a thing.

        Without this, Python's own message names the private classes:
        "unsupported operand type(s) for +: '_Rectangle' and '_Rectangle'".
        """
        raise TypeError(
            "Images cannot be joined with `+`. Use `beside(a, b)` to put them "
            "side by side, `above(a, b)` to stack them, or `overlay(a, b)` to "
            "put one on top of the other."
        )

    __radd__ = __add__


# -----------------------------------------------------------------------------
# Shapes
# -----------------------------------------------------------------------------

class _Rectangle(Image):
    def __init__(self, width, height, mode, paint):
        self._w = float(width)
        self._h = float(height)
        self._mode = mode
        self._paint = paint

    def _items(self, m, clip):
        return (("poly", clip, _pll_corners(m, self._w, self._h), self._mode, self._paint),)


def _pll_ellipse_item(m, clip, cx, cy, rx, ry, mode, paint):
    """The ellipse with radii `rx`, `ry` about (cx, cy), drawn with `m`.

    What a transform makes of an ellipse is another ellipse, whose radii
    and turn are the singular values and rotation of the transform's linear
    part (a closed form for 2x2).
    """
    x, y = _pll_apply(m, cx, cy)
    a00, a10 = m[0] * rx, m[1] * rx
    a01, a11 = m[2] * ry, m[3] * ry
    e, f = (a00 + a11) / 2, (a00 - a11) / 2
    g, h = (a10 + a01) / 2, (a10 - a01) / 2
    q, r = _math.hypot(e, h), _math.hypot(f, g)
    turn = (_math.atan2(h, e) + _math.atan2(g, f)) / 2
    return ("ellipse", clip, x, y, q + r, abs(q - r), _math.degrees(turn), mode, paint)


class _Circle(Image):
    def __init__(self, radius, mode, paint):
        self._radius = float(radius)
        self._w = self._h = self._radius * 2
        self._mode = mode
        self._paint = paint

    def _items(self, m, clip):
        r = self._radius
        return (_pll_ellipse_item(m, clip, r, r, r, r, self._mode, self._paint),)


class _Ellipse(Image):
    def __init__(self, width, height, mode, paint):
        self._w = float(width)
        self._h = float(height)
        self._mode = mode
        self._paint = paint

    def _items(self, m, clip):
        rx, ry = self._w / 2, self._h / 2
        return (_pll_ellipse_item(m, clip, rx, ry, rx, ry, self._mode, self._paint),)


class _Polygon(Image):
    """A polygon, measured by its points: its box is its real extent."""

    def __init__(self, points, mode, paint):
        left, top, right, bottom = _pll_bounds(points)
        self._points = tuple((x - left, y - top) for x, y in points)
        self._w = right - left
        self._h = bottom - top
        self._mode = mode
        self._paint = paint

    def _items(self, m, clip):
        return (("poly", clip, tuple(_pll_apply(m, x, y) for x, y in self._points), self._mode, self._paint),)


class _Line(Image):
    """A line `(dx, dy)` long, in a box at least a pixel each way."""

    def __init__(self, dx, dy, paint):
        self._dx = float(dx)
        self._dy = float(dy)
        self._w = max(abs(self._dx), 1.0)
        self._h = max(abs(self._dy), 1.0)
        self._paint = paint

    def _items(self, m, clip):
        x1 = (0.0 if self._dx >= 0 else -self._dx) + (self._w - abs(self._dx)) / 2
        y1 = (0.0 if self._dy >= 0 else -self._dy) + (self._h - abs(self._dy)) / 2
        (ax, ay), (bx, by) = _pll_apply(m, x1, y1), _pll_apply(m, x1 + self._dx, y1 + self._dy)
        return (("line", clip, ax, ay, bx, by, self._paint),)


class _Text(Image):
    """Text in a monospace font, so its size is exact: spaces are kept."""

    def __init__(self, text, size, paint):
        self._text = text
        self._size = float(size)
        self._w = _pll_text_cells(text) * self._size * _PLL_TEXT_ADVANCE
        self._h = self._size * _PLL_TEXT_HEIGHT
        self._paint = paint

    def _items(self, m, clip):
        return (("text", clip, m, self._text, self._size, self._w, self._h, self._paint),)


class _Drawing(Image):
    """A ready-made SVG of a known size - a chart - as an image like any other."""

    def __init__(self, markup, width, height):
        self._markup = markup
        self._w = float(width)
        self._h = float(height)

    def _items(self, m, clip):
        return (("svg", clip, m, self._w, self._h, self._markup),)

    def to_svg(self):
        return self._markup


class _PllBox(Image):
    """Nothing to see: the edges of a crop or a scene, for `rotate` to measure."""

    def __init__(self, width, height):
        self._w = float(width)
        self._h = float(height)

    def _items(self, m, clip):
        return (("box", clip, _pll_corners(m, self._w, self._h)),)


# -----------------------------------------------------------------------------
# Loading a picture from a file or a URL
# -----------------------------------------------------------------------------

def _pll_png_size(data):
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or data[12:16] != b"IHDR":
        return None
    return (
        int.from_bytes(data[16:20], "big"),
        int.from_bytes(data[20:24], "big"),
    )


def _pll_gif_size(data):
    if not data.startswith((b"GIF87a", b"GIF89a")):
        return None
    return (
        int.from_bytes(data[6:8], "little"),
        int.from_bytes(data[8:10], "little"),
    )


def _pll_jpeg_size(data):
    """Walk the segment chain to the frame header that carries the size."""
    if not data.startswith(b"\xff\xd8"):
        return None
    i = 2
    end = len(data)
    while i + 3 < end:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        # Standalone markers: no length field to skip.
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            i += 2
            continue
        length = int.from_bytes(data[i + 2:i + 4], "big")
        # Any SOFn except the four that are not frame headers.
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC, 0xD8):
            if i + 9 > end:
                return None
            return (
                int.from_bytes(data[i + 7:i + 9], "big"),
                int.from_bytes(data[i + 5:i + 7], "big"),
            )
        i += 2 + max(length, 2)
    return None


def _pll_webp_size(data):
    if not (data.startswith(b"RIFF") and data[8:12] == b"WEBP"):
        return None
    kind = data[12:16]
    if kind == b"VP8 ":
        return (
            int.from_bytes(data[26:28], "little") & 0x3FFF,
            int.from_bytes(data[28:30], "little") & 0x3FFF,
        )
    if kind == b"VP8L":
        bits = int.from_bytes(data[21:25], "little")
        return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    if kind == b"VP8X":
        return (
            int.from_bytes(data[24:27], "little") + 1,
            int.from_bytes(data[27:30], "little") + 1,
        )
    return None


#: Pixels in one of each absolute CSS unit.
_PLL_SVG_UNITS = {
    "": 1.0, "px": 1.0, "pt": 4 / 3, "pc": 16.0, "in": 96.0,
    "cm": 96 / 2.54, "mm": 96 / 25.4, "q": 96 / 101.6,
}
_PLL_SVG_TAG_RE = _pll_img_re.compile(r"<svg\b([^>]*)>", _pll_img_re.I)
_PLL_SVG_ATTR_RE = _pll_img_re.compile(r"""([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")
_PLL_SVG_LENGTH_RE = _pll_img_re.compile(r"^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*([a-z]*)\s*$", _pll_img_re.I)


def _pll_svg_size(data):
    """An SVG's size, from its own `<svg>` tag: `width` and `height`, or the viewBox.

    Read from that tag only, so a `stroke-width` or a child's `width` is not
    taken for the picture's, and with each unit turned into pixels. A size
    in `%` or `em` says nothing on its own, so the viewBox decides.
    """
    try:
        head = data[:65536].decode("utf-8", "replace")
    except Exception:
        return None
    # Past the prologue: comments can hold anything, an `<svg` included.
    head = _pll_img_re.sub(r"<!--.*?-->", "", head, flags=_pll_img_re.S)
    tag = _PLL_SVG_TAG_RE.search(head)
    if tag is None:
        return None
    attrs = {}
    for name, double, single in _PLL_SVG_ATTR_RE.findall(tag.group(1)):
        attrs[name.lower()] = double if double or not single else single

    def length(name):
        found = _PLL_SVG_LENGTH_RE.match(attrs.get(name, ""))
        if not found or found.group(2).lower() not in _PLL_SVG_UNITS:
            return None
        return float(found.group(1)) * _PLL_SVG_UNITS[found.group(2).lower()]

    w, h = length("width"), length("height")
    box = None
    numbers = _pll_img_re.split(r"[\s,]+", attrs.get("viewbox", "").strip())
    if len(numbers) == 4:
        try:
            box = (float(numbers[2]), float(numbers[3]))
        except ValueError:
            box = None
    if w and h:
        return (w, h)
    if box and box[0] > 0 and box[1] > 0:
        # One side given: the other follows the viewBox's shape.
        if w:
            return (w, w * box[1] / box[0])
        if h:
            return (h * box[0] / box[1], h)
        return box
    return None


#: Sniffers in the order they are tried, with the media type each implies.
_PLL_IMAGE_KINDS = (
    ("image/png", _pll_png_size),
    ("image/jpeg", _pll_jpeg_size),
    ("image/gif", _pll_gif_size),
    ("image/webp", _pll_webp_size),
    ("image/svg+xml", _pll_svg_size),
)

#: The largest picture `load_image` reads, from a file or an address: the
#: limit on a file beside the program.
_PLL_MAX_PICTURE_BYTES = 2 * 1024 * 1024


class _LoadedImage(Image):
    """A picture read from a file or a URL, carried as a data URI.

    Its bytes are embedded rather than linked, so the picture keeps working
    in a saved SVG, in the interactions panel and in a `.svg` written by
    `--save-images`, none of which can be relied on to fetch anything.
    """

    def __init__(self, width, height, media_type, data, source):
        self._w = float(width)
        self._h = float(height)
        self._media_type = media_type
        self._data = data
        self._source = source
        self._encoded = None

    def _href(self):
        if self._encoded is None:
            self._encoded = "data:%s;base64,%s" % (
                self._media_type,
                _pll_img_b64.b64encode(self._data).decode("ascii"),
            )
        return self._encoded

    def _items(self, m, clip):
        return (("bitmap", clip, m, self._w, self._h, self),)

    def __repr__(self):
        return "<image %gx%g from %s>" % (self._w, self._h, self._source)


def load_image(source):
    """Read a picture from a file beside your program, or from a URL.

    Which one is worked out from the text: anything starting `http://` or
    `https://` is fetched, anything else is a file name.

        load_image("cat.png")
        load_image("https://example.edu/cat.png")

    The result is an ordinary picture, so every combinator works on it -
    `scale`, `rotate`, `beside`, `place_image` and the rest. PNG, JPEG,
    GIF, WebP and SVG are understood, up to 2 MB.
    """
    data = _pll_read_source(source, "load_image", binary=True, limit=_PLL_MAX_PICTURE_BYTES)
    if not data:
        raise ValueError("%r is empty, so there is no picture in it." % source)
    for media_type, sniff in _PLL_IMAGE_KINDS:
        size = sniff(data)
        if size is None:
            continue
        width, height = size
        if width <= 0 or height <= 0:
            raise ValueError("%r says it is %gx%g, which is not a picture." % (source, width, height))
        return _LoadedImage(width, height, media_type, data, source)
    raise ValueError(
        "%r is not a picture PLL can read. It understands PNG, JPEG, GIF, "
        "WebP and SVG files." % source
    )


def _pll_figure_image(figure):
    """A matplotlib figure as a picture: a PNG at twice its size, for a sharp
    screen, shown at its own size."""
    import io as _pll_img_io

    out = _pll_img_io.BytesIO()
    figure.savefig(out, format="png", dpi=figure.dpi * 2)
    width, height = figure.get_size_inches() * figure.dpi
    return _LoadedImage(width, height, "image/png", out.getvalue(), "a figure")


def _pll_show_figure(figure):
    """Show a figure where the program's pictures go, and close it, so it is
    shown once."""
    _pll_push(_pll_extract_display(_pll_figure_image(figure)))
    pyplot = _pll_img_sys.modules.get("matplotlib.pyplot")
    if pyplot is not None:
        pyplot.close(figure)


# -----------------------------------------------------------------------------
# Combinators
# -----------------------------------------------------------------------------

_PLL_X_PLACES = ("left", "center", "middle", "right")
_PLL_Y_PLACES = ("top", "center", "middle", "bottom")

#: How each aligned combinator is written, for the message that says so.
_PLL_ALIGNED_EXAMPLES = {
    "beside_align": 'beside_align("top", image1, image2)',
    "above_align": 'above_align("left", image1, image2)',
    "overlay_align": 'overlay_align("left", "top", image1, image2)',
    "underlay_align": 'underlay_align("left", "top", image1, image2)',
}


def _pll_check_place(place, allowed, who, param):
    if isinstance(place, str) and place in allowed:
        return place
    if isinstance(place, Image):
        raise TypeError(
            "%s takes the alignment first, then the images: write %s."
            % (who, _PLL_ALIGNED_EXAMPLES[who])
        )
    suggestion = _pll_closest_name(place.lower(), allowed) if isinstance(place, str) else None
    raise ValueError(
        "%s's `%s`%s should be \"%s\", \"%s\" or \"%s\", but it is %s.%s"
        % (
            who,
            param,
            _pll_where(who, param),
            allowed[0],
            allowed[1],
            allowed[3],
            _pll_describe(place),
            ' Did you mean "%s"?' % suggestion if suggestion else "",
        )
    )


def _pll_offset(place, outer, inner):
    """Where a child of size `inner` sits inside a box of size `outer`."""
    if place in ("left", "top"):
        return 0.0
    if place in ("right", "bottom"):
        return outer - inner
    return (outer - inner) / 2.0


class _Beside(Image):
    """Children left to right, aligned vertically by `y_place`."""

    def __init__(self, children, y_place="center"):
        self._children = list(children)
        self._y_place = y_place
        self._w = sum(c._w for c in self._children)
        self._h = max((c._h for c in self._children), default=0.0)

    def _parts(self):
        parts = []
        x = 0.0
        for child in self._children:
            parts.append((child, _pll_translate(x, _pll_offset(self._y_place, self._h, child._h)), None))
            x += child._w
        return parts


class _Above(Image):
    """Children top to bottom, aligned horizontally by `x_place`."""

    def __init__(self, children, x_place="center"):
        self._children = list(children)
        self._x_place = x_place
        self._w = max((c._w for c in self._children), default=0.0)
        self._h = sum(c._h for c in self._children)

    def _parts(self):
        parts = []
        y = 0.0
        for child in self._children:
            parts.append((child, _pll_translate(_pll_offset(self._x_place, self._w, child._w), y), None))
            y += child._h
        return parts


class _Overlay(Image):
    """First child on top. Children aligned by (`x_place`, `y_place`)."""

    def __init__(self, children, x_place="center", y_place="center"):
        self._children = list(children)
        self._x_place = x_place
        self._y_place = y_place
        self._w = max(c._w for c in self._children)
        self._h = max(c._h for c in self._children)

    def _parts(self):
        return [
            (
                child,
                _pll_translate(
                    _pll_offset(self._x_place, self._w, child._w),
                    _pll_offset(self._y_place, self._h, child._h),
                ),
                None,
            )
            for child in reversed(self._children)
        ]


class _LayeredXY(Image):
    """`first` at the origin, `second` offset by (dx, dy).

    Negative offsets move `second` left / up, which grows the bounding box
    in that direction: both children move right / down by however far the
    box grew, so the picture's own top-left stays at (0, 0).
    """

    def __init__(self, first, dx, dy, second, first_on_top):
        self._first = first
        self._second = second
        self._dx = float(dx)
        self._dy = float(dy)
        self._first_on_top = first_on_top
        left, top = min(0.0, self._dx), min(0.0, self._dy)
        self._w = max(first._w, self._dx + second._w) - left
        self._h = max(first._h, self._dy + second._h) - top

    def _parts(self):
        shift_x = -min(0.0, self._dx)
        shift_y = -min(0.0, self._dy)
        first = (self._first, _pll_translate(shift_x, shift_y), None)
        second = (self._second, _pll_translate(shift_x + self._dx, shift_y + self._dy), None)
        return [second, first] if self._first_on_top else [first, second]


def _pll_box_region(w, h):
    return ((0.0, 0.0), (w, 0.0), (w, h), (0.0, h))


class _Crop(Image):
    """The `width` x `height` region of `image` starting at (`x`, `y`)."""

    def __init__(self, x, y, width, height, image):
        self._x = float(x)
        self._y = float(y)
        self._w = float(width)
        self._h = float(height)
        self._image = image

    def _parts(self):
        return [
            (self._image, _pll_translate(-self._x, -self._y), _pll_box_region(self._w, self._h)),
            (_PllBox(self._w, self._h), None, None),
        ]


class _PlaceImage(Image):
    """`image` centred at (cx, cy) on `scene`, cropped to the scene."""

    def __init__(self, image, cx, cy, scene):
        self._image = image
        self._cx = float(cx)
        self._cy = float(cy)
        self._scene = scene
        self._w = scene._w
        self._h = scene._h

    def _parts(self):
        region = _pll_box_region(self._w, self._h)
        at = _pll_translate(self._cx - self._image._w / 2.0, self._cy - self._image._h / 2.0)
        return [
            (self._scene, None, region),
            (self._image, at, region),
            (_PllBox(self._w, self._h), None, None),
        ]


class _Frame(Image):
    """`image` with a thin black outline around its bounding box."""

    def __init__(self, image):
        self._image = image
        self._w = image._w
        self._h = image._h

    def _parts(self):
        return [
            (self._image, None, None),
            (_Rectangle(self._w, self._h, "outline", _PLL_BLACK), None, None),
        ]


class _Rotate(Image):
    """`image` turned `angle` degrees counter-clockwise (HtDP convention).

    Its box is the turned shapes' own, as 2htdp's is: a circle stays as wide
    as it was, and turning a picture again and again does not grow it.
    """

    def __init__(self, angle, image):
        self._angle = angle % 360.0
        if self._angle % 90 == 0:
            # Exactly, so a quarter turn does not leave 6e-17 behind.
            cos, sin = ((1, 0), (0, 1), (-1, 0), (0, -1))[int(self._angle // 90)]
        else:
            rad = _math.radians(self._angle)
            cos, sin = _math.cos(rad), _math.sin(rad)
        # Counter-clockwise on a screen, where y grows downward.
        turn = (float(cos), float(-sin), float(sin), float(cos), 0.0, 0.0)
        boxes = [_pll_extent(item) for item in _pll_flatten(image, turn)]
        if boxes:
            left = min(b[0] for b in boxes)
            top = min(b[1] for b in boxes)
            self._w = max(b[2] for b in boxes) - left
            self._h = max(b[3] for b in boxes) - top
        else:
            left = top = 0.0
            self._w = self._h = 0.0
        self._image = image
        self._turn = _pll_compose(_pll_translate(-left, -top), turn)

    def _parts(self):
        return [(self._image, self._turn, None)]


class _Scale(Image):
    def __init__(self, factor, image):
        self._factor = float(factor)
        self._image = image
        self._w = image._w * self._factor
        self._h = image._h * self._factor

    def _parts(self):
        f = self._factor
        return [(self._image, (f, 0.0, 0.0, f, 0.0, 0.0), None)]


class _Flip(Image):
    def __init__(self, image, horizontal):
        self._image = image
        self._horizontal = horizontal
        self._w = image._w
        self._h = image._h

    def _parts(self):
        if self._horizontal:
            return [(self._image, (-1.0, 0.0, 0.0, 1.0, self._w, 0.0), None)]
        return [(self._image, (1.0, 0.0, 0.0, -1.0, 0.0, self._h), None)]


# -----------------------------------------------------------------------------
# Public API (exported into user globals by the install step)
# -----------------------------------------------------------------------------

def circle(radius, mode, color):
    """A circle: `mode` is "solid" or "outline"."""
    radius = _pll_check_size(radius, "circle", "radius")
    return _Circle(radius, _pll_check_mode(mode, "circle"), _pll_check_color(color, "circle"))


def square(side, mode, color):
    """A square with sides `side` long."""
    side = _pll_check_size(side, "square", "side")
    return _Rectangle(
        side, side, _pll_check_mode(mode, "square"), _pll_check_color(color, "square")
    )


def rectangle(width, height, mode, color):
    """A rectangle `width` across and `height` high."""
    width = _pll_check_size(width, "rectangle", "width")
    height = _pll_check_size(height, "rectangle", "height")
    return _Rectangle(
        width, height,
        _pll_check_mode(mode, "rectangle"), _pll_check_color(color, "rectangle"),
    )


def ellipse(width, height, mode, color):
    """An ellipse `width` across and `height` high."""
    width = _pll_check_size(width, "ellipse", "width")
    height = _pll_check_size(height, "ellipse", "height")
    return _Ellipse(
        width, height,
        _pll_check_mode(mode, "ellipse"), _pll_check_color(color, "ellipse"),
    )


def triangle(side, mode, color):
    """An equilateral triangle pointing up, with sides `side` long."""
    side = _pll_check_size(side, "triangle", "side")
    h = side * _math.sqrt(3) / 2.0
    points = [(side / 2.0, 0.0), (side, h), (0.0, h)]
    return _Polygon(
        points, _pll_check_mode(mode, "triangle"), _pll_check_color(color, "triangle")
    )


def right_triangle(width, height, mode, color):
    """A right triangle: legs `width` along the bottom and `height` up the left."""
    width = _pll_check_size(width, "right_triangle", "width")
    height = _pll_check_size(height, "right_triangle", "height")
    mode = _pll_check_mode(mode, "right_triangle")
    paint = _pll_check_color(color, "right_triangle")
    # The right angle at the bottom left, as 2htdp draws it.
    return _Polygon([(0.0, 0.0), (0.0, height), (width, height)], mode, paint)


def regular_polygon(side, sides, mode, color):
    """A regular polygon with `sides` sides, each `side` long."""
    side = _pll_check_size(side, "regular_polygon", "side")
    sides = _pll_check_count(sides, "regular_polygon", "sides", 3)
    mode = _pll_check_mode(mode, "regular_polygon")
    paint = _pll_check_color(color, "regular_polygon")
    radius = side / (2 * _math.sin(_math.pi / sides))
    # Oriented with a *side* along the bottom, which is what a regular
    # polygon is expected to look like. With an odd number of sides a
    # vertex at the top already gives that - a triangle points up - but
    # with an even number it puts a vertex at the bottom too, so
    # `regular_polygon(40, 4, ...)` would be a 57x57 diamond instead of a
    # 40x40 square. Half a step of rotation fixes the even cases and leaves
    # the odd ones alone.
    offset = 0.0 if sides % 2 else _math.pi / sides
    points = []
    for i in range(sides):
        # start at the top and go clockwise
        angle = -_math.pi / 2.0 + offset + i * 2 * _math.pi / sides
        points.append((radius + radius * _math.cos(angle), radius + radius * _math.sin(angle)))
    # `_Polygon` measures the points it is given, so the box is the shape's
    # real extent rather than the circle it was cut from.
    return _Polygon(points, mode, paint)


def _pll_star_points(side, count, step):
    """The outline of the star polygon {count/step} around a regular polygon.

    Its points are the polygon's corners; between them, where the lines
    joining every `step`-th corner cross, at R*cos(pi*step/count) /
    cos(pi*(step-1)/count) from the centre.
    """
    radius = side / (2 * _math.sin(_math.pi / count))
    inner = radius * _math.cos(_math.pi * step / count) / _math.cos(_math.pi * (step - 1) / count)
    points = []
    for i in range(count * 2):
        r = radius if i % 2 == 0 else inner
        angle = -_math.pi / 2.0 + i * _math.pi / count
        points.append((radius + r * _math.cos(angle), radius + r * _math.sin(angle)))
    return points


def star(side, mode, color):
    """A five-pointed star, its points the corners of a pentagon with sides `side` long."""
    side = _pll_check_size(side, "star", "side")
    mode = _pll_check_mode(mode, "star")
    paint = _pll_check_color(color, "star")
    return _Polygon(_pll_star_points(side, 5, 2), mode, paint)


def star_polygon(side, points_count, step, mode, color):
    """A star with `points_count` points, joining every `step`-th corner of a
    regular polygon with sides `side` long: (40, 5, 2, ...) is the usual star."""
    side = _pll_check_size(side, "star_polygon", "side")
    count = _pll_check_count(points_count, "star_polygon", "points_count", 3)
    step = _pll_check_count(step, "star_polygon", "step", 1)
    if step * 2 >= count:
        raise ValueError(
            "star_polygon's `step`%s has to be less than half of `points_count`, "
            "but it is %d with %d points - joining every %s corner of %d makes no star.%s"
            % (
                _pll_where("star_polygon", "step"),
                step,
                count,
                _pll_ordinal(step - 1),
                count,
                _pll_contract("star_polygon"),
            )
        )
    mode = _pll_check_mode(mode, "star_polygon")
    paint = _pll_check_color(color, "star_polygon")
    return _Polygon(_pll_star_points(side, count, step), mode, paint)


def line(dx, dy, color):
    """A line from its top-left corner going `dx` across and `dy` down."""
    dx = _pll_check_number(dx, "line", "dx")
    dy = _pll_check_number(dy, "line", "dy")
    return _Line(dx, dy, _pll_check_color(color, "line"))


def text(value, size, color):
    """`value` written in letters `size` pixels high."""
    if not isinstance(value, str):
        raise TypeError(
            "text's `value` (the 1st argument) must be a string, but it is %s."
            " The arguments are: text(value, size, color)." % _pll_describe(value)
        )
    size = _pll_check_positive(size, "text", "size")
    return _Text(value, size, _pll_check_color(color, "text"))


def beside(*images):
    """The images side by side, left to right, lined up on their centres."""
    return _Beside(_pll_check_images(images, "beside"))


def above(*images):
    """The images one above the other, top to bottom, lined up on their centres."""
    return _Above(_pll_check_images(images, "above"))


def overlay(*images):
    """The images on top of one another, centred; the first is on top."""
    return _Overlay(_pll_check_images(images, "overlay", least=1))


def underlay(*images):
    """Like overlay, but the first image is on the bottom."""
    return _Overlay(list(reversed(_pll_check_images(images, "underlay", least=1))))


def beside_align(y_place, *images):
    """Like `beside`, lined up by "top", "center" or "bottom"."""
    return _Beside(
        _pll_check_images(images, "beside_align", 1),
        _pll_check_place(y_place, _PLL_Y_PLACES, "beside_align", "y_place"),
    )


def above_align(x_place, *images):
    """Like `above`, lined up by "left", "center" or "right"."""
    return _Above(
        _pll_check_images(images, "above_align", 1),
        _pll_check_place(x_place, _PLL_X_PLACES, "above_align", "x_place"),
    )


def overlay_align(x_place, y_place, *images):
    """Like `overlay`, with both ways of lining up given."""
    x_place = _pll_check_place(x_place, _PLL_X_PLACES, "overlay_align", "x_place")
    y_place = _pll_check_place(y_place, _PLL_Y_PLACES, "overlay_align", "y_place")
    return _Overlay(_pll_check_images(images, "overlay_align", 2, least=1), x_place, y_place)


def underlay_align(x_place, y_place, *images):
    """Like `overlay_align`, but the first image is on the bottom."""
    x_place = _pll_check_place(x_place, _PLL_X_PLACES, "underlay_align", "x_place")
    y_place = _pll_check_place(y_place, _PLL_Y_PLACES, "underlay_align", "y_place")
    return _Overlay(
        list(reversed(_pll_check_images(images, "underlay_align", 2, least=1))), x_place, y_place
    )


def overlay_xy(image1, dx, dy, image2):
    """`image1` on top; `image2` moved `dx` right and `dy` down from it.

    Negative offsets move `image2` left / up and the picture grows that way,
    so nothing is ever cut off.
    """
    _pll_check_image(image1, "overlay_xy", 0)
    dx = _pll_check_number(dx, "overlay_xy", "dx")
    dy = _pll_check_number(dy, "overlay_xy", "dy")
    _pll_check_image(image2, "overlay_xy", 3)
    return _LayeredXY(image1, dx, dy, image2, first_on_top=True)


def underlay_xy(image1, dx, dy, image2):
    """`image1` underneath; `image2` moved `dx` right and `dy` down."""
    _pll_check_image(image1, "underlay_xy", 0)
    dx = _pll_check_number(dx, "underlay_xy", "dx")
    dy = _pll_check_number(dy, "underlay_xy", "dy")
    _pll_check_image(image2, "underlay_xy", 3)
    return _LayeredXY(image1, dx, dy, image2, first_on_top=False)


def place_image(image, x, y, scene):
    """Put `image`'s *centre* at (x, y) on `scene`, cropped to the scene."""
    _pll_check_image(image, "place_image", 0)
    x = _pll_check_number(x, "place_image", "x")
    y = _pll_check_number(y, "place_image", "y")
    _pll_check_image(scene, "place_image", 3)
    return _PlaceImage(image, x, y, scene)


def crop(x, y, width, height, image):
    """The `width` x `height` piece of `image` starting at (x, y)."""
    x = _pll_check_number(x, "crop", "x")
    y = _pll_check_number(y, "crop", "y")
    width = _pll_check_size(width, "crop", "width")
    height = _pll_check_size(height, "crop", "height")
    _pll_check_image(image, "crop", 4)
    return _Crop(x, y, width, height, image)


def frame(image):
    """`image` with a thin outline around it, to show its bounding box."""
    return _Frame(_pll_check_image(image, "frame", 0))


def empty_scene(width, height):
    """A blank white scene with an outline, to use with `place_image`."""
    width = _pll_check_size(width, "empty_scene", "width")
    height = _pll_check_size(height, "empty_scene", "height")
    return _Frame(_Rectangle(width, height, "solid", _PLL_WHITE))


def rotate(angle, image):
    """`image` turned `angle` degrees counter-clockwise."""
    _pll_check_order(angle, image, "rotate", "angle")
    angle = _pll_check_number(angle, "rotate", "angle")
    return _Rotate(angle, _pll_check_image(image, "rotate", 1))


def scale(factor, image):
    """`image` made `factor` times bigger (or smaller, below 1)."""
    _pll_check_order(factor, image, "scale", "factor")
    factor = _pll_check_positive(factor, "scale", "factor")
    return _Scale(factor, _pll_check_image(image, "scale", 1))


def flip_horizontal(image):
    """`image` mirrored left to right."""
    return _Flip(_pll_check_image(image, "flip_horizontal", 0), horizontal=True)


def flip_vertical(image):
    """`image` mirrored top to bottom."""
    return _Flip(_pll_check_image(image, "flip_vertical", 0), horizontal=False)


def image_width(image):
    """How many pixels across `image` is."""
    return _pll_px(_pll_check_image(image, "image_width", 0)._w)


def image_height(image):
    """How many pixels high `image` is."""
    return _pll_px(_pll_check_image(image, "image_height", 0)._h)


empty_image = _Rectangle(0, 0, "solid", _PLL_TRANSPARENT)


# Names exported into user globals by the install step. Keep this list explicit
# so we don't accidentally leak helpers (anything starting with `_` would
# already be filtered, but being explicit avoids drift).
PLL_IMAGE_EXPORTS = [
    "Image",
    "circle",
    "square",
    "rectangle",
    "ellipse",
    "triangle",
    "right_triangle",
    "regular_polygon",
    "star",
    "star_polygon",
    "line",
    "text",
    "beside",
    "above",
    "overlay",
    "underlay",
    "beside_align",
    "above_align",
    "overlay_align",
    "underlay_align",
    "overlay_xy",
    "underlay_xy",
    "place_image",
    "crop",
    "frame",
    "empty_scene",
    "rotate",
    "scale",
    "flip_horizontal",
    "flip_vertical",
    "image_width",
    "image_height",
    "empty_image",
    "load_image",
]


# Argument names, read off the functions above rather than written out a
# second time, so `_pll_where` and `_pll_contract` cannot fall out of step
# with the contracts they quote. `*images` is left out: a function that
# takes any number of them has no fixed positions to name. Each function
# says it is `pll.image`'s, so `help(circle)` does.
for _pll_exported in PLL_IMAGE_EXPORTS:
    _pll_value = globals()[_pll_exported]
    if not callable(_pll_value) or isinstance(_pll_value, type):
        continue
    _pll_value.__module__ = "pll.image"
    _PLL_PARAMS[_pll_exported] = tuple(
        _name
        for _name in _pll_value.__code__.co_varnames[: _pll_value.__code__.co_argcount]
    )
del _pll_exported, _pll_value
