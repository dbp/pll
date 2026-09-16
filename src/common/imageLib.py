# PLL image library.
#
# A small, immutable, HtDP-style image library inspired by Racket's
# `2htdp/image` and Pyret's `image-lib`. Every primitive and combinator
# returns a new `Image`; nothing mutates. Each `Image` knows how to render
# itself as an SVG fragment positioned in a parent box.
#
# This module is loaded into Pyodide alongside `pyodideBootstrap.py`. The
# bootstrap then injects the public names directly into the user's module
# globals so a beginner can write `circle(50, "solid", "red")` with no
# import boilerplate (matching the HtDP/Pyret experience).

import math as _math


# -----------------------------------------------------------------------------
# Color handling
# -----------------------------------------------------------------------------

def _pll_color_to_css(color):
    """Convert a PLL color value to an SVG/CSS color string.

    Accepts:
      - a string CSS name or hex ("red", "#ff0000")
      - an (r, g, b) tuple/list of integers 0..255
      - an (r, g, b, a) tuple/list, a in 0..1 or 0..255
    """
    if isinstance(color, str):
        return color
    if isinstance(color, (tuple, list)):
        if len(color) == 3:
            r, g, b = color
            return "rgb(%d, %d, %d)" % (int(r), int(g), int(b))
        if len(color) == 4:
            r, g, b, a = color
            if a > 1:
                a = a / 255.0
            return "rgba(%d, %d, %d, %g)" % (int(r), int(g), int(b), a)
    return str(color)


def _pll_xml_escape(text):
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


# -----------------------------------------------------------------------------
# Image base class
# -----------------------------------------------------------------------------
#
# Each Image has:
#   width / height            -> bounding box in pixels
#   _render_body(x, y)        -> SVG fragment positioned at (x, y) in
#                                its parent's coordinate system
#   to_svg()                  -> standalone <svg> document
#   _pll_image_data()      -> dict the host uses to display the image
#

class Image:
    """Base class for all PLL images. Don't instantiate directly."""

    @property
    def width(self):
        raise NotImplementedError

    @property
    def height(self):
        raise NotImplementedError

    def _render_body(self, x, y):
        raise NotImplementedError

    def to_svg(self):
        body = self._render_body(0, 0)
        # Use ceil to give a tiny bit of room so antialiased edges aren't clipped.
        w = max(1, int(_math.ceil(self.width)))
        h = max(1, int(_math.ceil(self.height)))
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" '
            'width="%d" height="%d" '
            'viewBox="0 0 %d %d" '
            'shape-rendering="geometricPrecision">%s</svg>'
        ) % (w, h, w, h, body)

    def _pll_image_data(self):
        return {
            "type": "svg",
            "width": int(_math.ceil(self.width)),
            "height": int(_math.ceil(self.height)),
            "data": self.to_svg(),
        }

    def __repr__(self):
        return "<Image %dx%d>" % (
            int(_math.ceil(self.width)),
            int(_math.ceil(self.height)),
        )


# -----------------------------------------------------------------------------
# Primitive shapes
# -----------------------------------------------------------------------------

def _pll_paint_attrs(mode, color):
    """Return SVG paint attributes for a `mode` ("solid" / "outline") shape."""
    css = _pll_color_to_css(color)
    if mode == "outline":
        return 'fill="none" stroke="%s" stroke-width="2"' % css
    # default: solid
    return 'fill="%s"' % css


class _Circle(Image):
    def __init__(self, radius, mode, color):
        self._radius = float(radius)
        self._mode = mode
        self._color = color

    @property
    def width(self):
        return self._radius * 2

    @property
    def height(self):
        return self._radius * 2

    def _render_body(self, x, y):
        cx = x + self._radius
        cy = y + self._radius
        return '<circle cx="%g" cy="%g" r="%g" %s />' % (
            cx, cy, self._radius, _pll_paint_attrs(self._mode, self._color),
        )


class _Rectangle(Image):
    def __init__(self, width, height, mode, color):
        self._w = float(width)
        self._h = float(height)
        self._mode = mode
        self._color = color

    @property
    def width(self):
        return self._w

    @property
    def height(self):
        return self._h

    def _render_body(self, x, y):
        return '<rect x="%g" y="%g" width="%g" height="%g" %s />' % (
            x, y, self._w, self._h,
            _pll_paint_attrs(self._mode, self._color),
        )


class _Ellipse(Image):
    def __init__(self, width, height, mode, color):
        self._w = float(width)
        self._h = float(height)
        self._mode = mode
        self._color = color

    @property
    def width(self):
        return self._w

    @property
    def height(self):
        return self._h

    def _render_body(self, x, y):
        rx = self._w / 2.0
        ry = self._h / 2.0
        return '<ellipse cx="%g" cy="%g" rx="%g" ry="%g" %s />' % (
            x + rx, y + ry, rx, ry,
            _pll_paint_attrs(self._mode, self._color),
        )


class _Polygon(Image):
    """A polygon defined by points relative to its top-left bounding box."""

    def __init__(self, points, mode, color):
        # points: list of (px, py) within the local 0..w / 0..h box
        if not points:
            raise ValueError("polygon needs at least one point")
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        self._w = max(xs) - min(xs)
        self._h = max(ys) - min(ys)
        self._origin_x = min(xs)
        self._origin_y = min(ys)
        self._points = points
        self._mode = mode
        self._color = color

    @property
    def width(self):
        return self._w

    @property
    def height(self):
        return self._h

    def _render_body(self, x, y):
        coords = " ".join(
            "%g,%g" % (x + (px - self._origin_x), y + (py - self._origin_y))
            for px, py in self._points
        )
        return '<polygon points="%s" %s />' % (
            coords, _pll_paint_attrs(self._mode, self._color),
        )


class _Line(Image):
    def __init__(self, dx, dy, color):
        self._dx = float(dx)
        self._dy = float(dy)
        self._color = color

    @property
    def width(self):
        return abs(self._dx) if abs(self._dx) > 1 else 1

    @property
    def height(self):
        return abs(self._dy) if abs(self._dy) > 1 else 1

    def _render_body(self, x, y):
        x1 = x + (0 if self._dx >= 0 else -self._dx)
        y1 = y + (0 if self._dy >= 0 else -self._dy)
        x2 = x1 + self._dx
        y2 = y1 + self._dy
        return '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="2" stroke-linecap="round" />' % (
            x1, y1, x2, y2, _pll_color_to_css(self._color),
        )


class _Text(Image):
    """SVG text. Width is estimated; SVG handles actual glyph layout."""

    def __init__(self, text, size, color):
        self._text = str(text)
        self._size = float(size)
        self._color = color

    @property
    def width(self):
        # crude estimate, ~0.6em per char on average
        return max(1, len(self._text)) * self._size * 0.6

    @property
    def height(self):
        return self._size * 1.2

    def _render_body(self, x, y):
        # Position baseline so glyphs sit inside the bounding box.
        baseline = y + self._size
        return (
            '<text x="%g" y="%g" font-family="sans-serif" font-size="%g" fill="%s" '
            'text-rendering="optimizeLegibility">%s</text>'
        ) % (
            x, baseline, self._size,
            _pll_color_to_css(self._color),
            _pll_xml_escape(self._text),
        )


# -----------------------------------------------------------------------------
# Combinators
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Alignment (HtDP's x-place / y-place)
# -----------------------------------------------------------------------------

_PLL_X_PLACES = ("left", "center", "middle", "right")
_PLL_Y_PLACES = ("top", "center", "middle", "bottom")


def _pll_check_place(place, allowed, who):
    if place not in allowed:
        raise ValueError(
            "%s: expected one of %s, got %r"
            % (who, ", ".join(repr(p) for p in allowed), place)
        )
    return place


def _pll_offset(place, outer, inner):
    """Where a child of size `inner` sits inside a box of size `outer`."""
    if place in ("left", "top"):
        return 0.0
    if place in ("right", "bottom"):
        return outer - inner
    return (outer - inner) / 2.0


_pll_clip_seq = 0


def _pll_next_clip_id():
    """Unique per element: two crops in one picture must not share an id."""
    global _pll_clip_seq
    _pll_clip_seq += 1
    return "pllclip%d" % _pll_clip_seq


def _pll_clipped(body, x, y, width, height):
    """`body`, with everything outside the given rectangle clipped away."""
    cid = _pll_next_clip_id()
    return (
        '<defs><clipPath id="%s">'
        '<rect x="%g" y="%g" width="%g" height="%g"/>'
        "</clipPath></defs>"
        '<g clip-path="url(#%s)">%s</g>'
    ) % (cid, x, y, width, height, cid, body)


class _Beside(Image):
    """Children left to right, aligned vertically by `y_place`."""

    def __init__(self, children, y_place="center"):
        self._children = list(children)
        self._y_place = y_place

    @property
    def width(self):
        return sum(c.width for c in self._children)

    @property
    def height(self):
        return max((c.height for c in self._children), default=0)

    def _render_body(self, x, y):
        out = []
        cx = x
        h = self.height
        for child in self._children:
            cy = y + _pll_offset(self._y_place, h, child.height)
            out.append(child._render_body(cx, cy))
            cx += child.width
        return "".join(out)


class _Above(Image):
    """Children top to bottom, aligned horizontally by `x_place`."""

    def __init__(self, children, x_place="center"):
        self._children = list(children)
        self._x_place = x_place

    @property
    def width(self):
        return max((c.width for c in self._children), default=0)

    @property
    def height(self):
        return sum(c.height for c in self._children)

    def _render_body(self, x, y):
        out = []
        cy = y
        w = self.width
        for child in self._children:
            cx = x + _pll_offset(self._x_place, w, child.width)
            out.append(child._render_body(cx, cy))
            cy += child.height
        return "".join(out)


class _Overlay(Image):
    """First arg is on top. Children aligned by (`x_place`, `y_place`)."""

    def __init__(self, children, x_place="center", y_place="center"):
        if not children:
            raise ValueError("overlay needs at least one image")
        self._children = list(children)
        self._x_place = x_place
        self._y_place = y_place

    @property
    def width(self):
        return max(c.width for c in self._children)

    @property
    def height(self):
        return max(c.height for c in self._children)

    def _render_body(self, x, y):
        # SVG draws in document order, so render bottom-up: last arg first.
        out = []
        w = self.width
        h = self.height
        for child in reversed(self._children):
            cx = x + _pll_offset(self._x_place, w, child.width)
            cy = y + _pll_offset(self._y_place, h, child.height)
            out.append(child._render_body(cx, cy))
        return "".join(out)


class _LayeredXY(Image):
    """`first` at the origin, `second` offset by (dx, dy).

    Negative offsets move `second` left / up, which grows the bounding box
    in that direction - so the composite's own origin shifts. The class
    absorbs that itself: it reports the union size and moves *both* children
    right / down by however far the box grew, so the protocol's "draw with
    your top-left at (x, y)" contract still holds for whoever renders it.
    Nothing else in the library needs to know about negative coordinates.
    """

    def __init__(self, first, dx, dy, second, first_on_top):
        self._first = first
        self._second = second
        self._dx = float(dx)
        self._dy = float(dy)
        self._first_on_top = first_on_top

    @property
    def width(self):
        left = min(0.0, self._dx)
        right = max(self._first.width, self._dx + self._second.width)
        return right - left

    @property
    def height(self):
        top = min(0.0, self._dy)
        bottom = max(self._first.height, self._dy + self._second.height)
        return bottom - top

    def _render_body(self, x, y):
        shift_x = -min(0.0, self._dx)
        shift_y = -min(0.0, self._dy)
        first = self._first._render_body(x + shift_x, y + shift_y)
        second = self._second._render_body(
            x + shift_x + self._dx, y + shift_y + self._dy
        )
        # Document order is painting order, so whatever is on top goes last.
        return (second + first) if self._first_on_top else (first + second)


class _Crop(Image):
    """The `width` x `height` region of `image` starting at (`x`, `y`)."""

    def __init__(self, x, y, width, height, image):
        if width < 0 or height < 0:
            raise ValueError("crop needs a width and height of at least 0")
        self._x = float(x)
        self._y = float(y)
        self._w = float(width)
        self._h = float(height)
        self._image = image

    @property
    def width(self):
        return self._w

    @property
    def height(self):
        return self._h

    def _render_body(self, x, y):
        # Shift the source so the requested region lands at (x, y), then
        # clip away everything outside it.
        body = self._image._render_body(x - self._x, y - self._y)
        return _pll_clipped(body, x, y, self._w, self._h)


class _PlaceImage(Image):
    """`image` centered at (cx, cy) on `scene`, cropped to the scene."""

    def __init__(self, image, cx, cy, scene):
        self._image = image
        self._cx = float(cx)
        self._cy = float(cy)
        self._scene = scene

    @property
    def width(self):
        return self._scene.width

    @property
    def height(self):
        return self._scene.height

    def _render_body(self, x, y):
        ix = x + self._cx - self._image.width / 2.0
        iy = y + self._cy - self._image.height / 2.0
        body = self._scene._render_body(x, y) + self._image._render_body(ix, iy)
        return _pll_clipped(body, x, y, self.width, self.height)


class _Frame(Image):
    """`image` with a thin outline around its bounding box."""

    def __init__(self, image):
        self._image = image

    @property
    def width(self):
        return self._image.width

    @property
    def height(self):
        return self._image.height

    def _render_body(self, x, y):
        # Half-pixel inset so a 1-unit stroke sits inside the bounding box
        # instead of straddling its edge.
        box = (
            '<rect x="%g" y="%g" width="%g" height="%g" '
            'fill="none" stroke="black" stroke-width="1"/>'
        ) % (
            x + 0.5,
            y + 0.5,
            max(0.0, self.width - 1.0),
            max(0.0, self.height - 1.0),
        )
        return self._image._render_body(x, y) + box


class _Rotate(Image):
    """Rotate `image` counter-clockwise by `angle` degrees (HtDP convention)."""

    def __init__(self, angle, image):
        self._angle = float(angle) % 360.0
        self._image = image

    @property
    def width(self):
        rad = _math.radians(self._angle)
        w = self._image.width
        h = self._image.height
        return abs(w * _math.cos(rad)) + abs(h * _math.sin(rad))

    @property
    def height(self):
        rad = _math.radians(self._angle)
        w = self._image.width
        h = self._image.height
        return abs(w * _math.sin(rad)) + abs(h * _math.cos(rad))

    def _render_body(self, x, y):
        # Place the unrotated child centered inside the rotated bounding box,
        # then rotate around its center. SVG's `rotate` is clockwise positive,
        # we want counter-clockwise positive, so we negate.
        cw = self._image.width
        ch = self._image.height
        bw = self.width
        bh = self.height
        ox = x + (bw - cw) / 2.0
        oy = y + (bh - ch) / 2.0
        body = self._image._render_body(0, 0)
        return (
            '<g transform="translate(%g,%g) rotate(%g,%g,%g)">%s</g>'
        ) % (ox, oy, -self._angle, cw / 2.0, ch / 2.0, body)


class _Scale(Image):
    def __init__(self, factor, image):
        self._fx = float(factor)
        self._fy = float(factor)
        self._image = image

    @property
    def width(self):
        return self._image.width * self._fx

    @property
    def height(self):
        return self._image.height * self._fy

    def _render_body(self, x, y):
        body = self._image._render_body(0, 0)
        return '<g transform="translate(%g,%g) scale(%g,%g)">%s</g>' % (
            x, y, self._fx, self._fy, body,
        )


class _Flip(Image):
    def __init__(self, image, horizontal):
        self._image = image
        self._horizontal = horizontal

    @property
    def width(self):
        return self._image.width

    @property
    def height(self):
        return self._image.height

    def _render_body(self, x, y):
        body = self._image._render_body(0, 0)
        if self._horizontal:
            tx = x + self.width
            return '<g transform="translate(%g,%g) scale(-1,1)">%s</g>' % (tx, y, body)
        ty = y + self.height
        return '<g transform="translate(%g,%g) scale(1,-1)">%s</g>' % (x, ty, body)


# -----------------------------------------------------------------------------
# Public API (exported into user globals by the bootstrap)
# -----------------------------------------------------------------------------

def circle(radius, mode, color):
    """Solid or outline circle."""
    return _Circle(radius, mode, color)


def square(side, mode, color):
    """Square with the given side length."""
    return _Rectangle(side, side, mode, color)


def rectangle(width, height, mode, color):
    return _Rectangle(width, height, mode, color)


def ellipse(width, height, mode, color):
    return _Ellipse(width, height, mode, color)


def triangle(side, mode, color):
    """Equilateral triangle pointing up."""
    h = side * _math.sqrt(3) / 2.0
    points = [(side / 2.0, 0.0), (side, h), (0.0, h)]
    return _Polygon(points, mode, color)


def right_triangle(width, height, mode, color):
    """Right triangle with legs `width` (bottom) and `height` (right)."""
    points = [(0.0, height), (width, height), (width, 0.0)]
    return _Polygon(points, mode, color)


def regular_polygon(side, sides, mode, color):
    """Regular polygon with `sides` sides each `side` units long."""
    if sides < 3:
        raise ValueError("regular_polygon needs at least 3 sides")
    radius = side / (2 * _math.sin(_math.pi / sides))
    points = []
    for i in range(sides):
        # start at the top and go clockwise
        angle = -_math.pi / 2.0 + i * 2 * _math.pi / sides
        px = radius + radius * _math.cos(angle)
        py = radius + radius * _math.sin(angle)
        points.append((px, py))
    return _Polygon(points, mode, color)


def star(side, mode, color):
    """5-point star with the given outer "side" length."""
    return star_polygon(side, 5, 2, mode, color)


def star_polygon(side, points_count, step, mode, color):
    """An n-pointed star with the given inner step (e.g. 5/2 -> classic star)."""
    if points_count < 3 or step < 1:
        raise ValueError("invalid star_polygon arguments")
    radius = side / (2 * _math.sin(_math.pi / points_count))
    pts = []
    n = points_count * 2
    inner_radius = radius * _math.cos(step * _math.pi / points_count)
    for i in range(n):
        r = radius if i % 2 == 0 else inner_radius
        angle = -_math.pi / 2.0 + i * _math.pi / points_count
        px = radius + r * _math.cos(angle)
        py = radius + r * _math.sin(angle)
        pts.append((px, py))
    return _Polygon(pts, mode, color)


def line(dx, dy, color):
    """Line going `(dx, dy)` from its top-left anchor."""
    return _Line(dx, dy, color)


def text(value, size, color):
    return _Text(value, size, color)


def beside(*images):
    return _Beside(images)


def above(*images):
    return _Above(images)


def overlay(*images):
    return _Overlay(images)


def underlay(*images):
    """Like overlay, but first arg is on the bottom."""
    return _Overlay(list(reversed(images)))


def beside_align(y_place, *images):
    """Like `beside`, aligned by "top" / "center" / "bottom"."""
    return _Beside(images, _pll_check_place(y_place, _PLL_Y_PLACES, "beside_align"))


def above_align(x_place, *images):
    """Like `above`, aligned by "left" / "center" / "right"."""
    return _Above(images, _pll_check_place(x_place, _PLL_X_PLACES, "above_align"))


def overlay_align(x_place, y_place, *images):
    """Like `overlay`, with both axes aligned explicitly."""
    return _Overlay(
        images,
        _pll_check_place(x_place, _PLL_X_PLACES, "overlay_align"),
        _pll_check_place(y_place, _PLL_Y_PLACES, "overlay_align"),
    )


def underlay_align(x_place, y_place, *images):
    """Like `overlay_align`, but the first image is on the bottom."""
    return _Overlay(
        list(reversed(images)),
        _pll_check_place(x_place, _PLL_X_PLACES, "underlay_align"),
        _pll_check_place(y_place, _PLL_Y_PLACES, "underlay_align"),
    )


def overlay_xy(image1, dx, dy, image2):
    """`image1` on top; `image2` moved `dx` right and `dy` down from it.

    Negative offsets move `image2` left / up and the picture grows that way,
    so nothing is ever cut off.
    """
    return _LayeredXY(image1, dx, dy, image2, first_on_top=True)


def underlay_xy(image1, dx, dy, image2):
    """`image1` underneath; `image2` moved `dx` right and `dy` down."""
    return _LayeredXY(image1, dx, dy, image2, first_on_top=False)


def place_image(image, x, y, scene):
    """Put `image`'s *center* at (x, y) on `scene`, cropped to the scene."""
    return _PlaceImage(image, x, y, scene)


def crop(x, y, width, height, image):
    """The `width` x `height` piece of `image` starting at (x, y)."""
    return _Crop(x, y, width, height, image)


def frame(image):
    """`image` with a thin outline around it, to show its bounding box."""
    return _Frame(image)


def empty_scene(width, height):
    """A blank white scene with an outline, to use with `place_image`."""
    return _Frame(_Rectangle(width, height, "solid", "white"))


def rotate(angle, image):
    return _Rotate(angle, image)


def scale(factor, image):
    return _Scale(factor, image)


def flip_horizontal(image):
    return _Flip(image, horizontal=True)


def flip_vertical(image):
    return _Flip(image, horizontal=False)


def image_width(image):
    return int(_math.ceil(image.width))


def image_height(image):
    return int(_math.ceil(image.height))


empty_image = _Rectangle(0, 0, "solid", (0, 0, 0, 0))


# Names exported into user globals by the bootstrap. Keep this list explicit
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
]
