#level raw

# Raw is what you get with no header at all: plain Python, with nothing
# added except PLL's built-in libraries (images, tables) and the
# interactions panel. No static checks and no annotation checks.
#
# The annotations below are wrong on purpose. At every other level the
# program stops on the first one; here it runs to the end, exactly as
# `python raw.py` would.

def add(x: int, y: int) -> int:
    return x + y


print(add("a", "b"))

count: int = True
print(count)

circle(40, "solid", "teal")
