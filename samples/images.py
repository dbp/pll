#beginner

# Bare top-level expressions are auto-displayed inline in the Bonnie
# interactions view, alongside any text output.

circle(50, "solid", "red")

beside(
    circle(30, "solid", "tomato"),
    square(60, "outline", "navy"),
    triangle(70, "solid", "gold"),
)

# A simple flag-style composition.
above(
    rectangle(180, 30, "solid", "black"),
    rectangle(180, 30, "solid", "red"),
    rectangle(180, 30, "solid", "gold"),
)

# Rotated and overlaid.
overlay(
    star(20, "solid", "white"),
    rotate(45, square(80, "solid", "darkblue")),
)

# Scaled.
scale(1.5, regular_polygon(20, 6, "solid", "mediumseagreen"))

# Text counts as an image too.
text("Hello!", 32, "navy")
