#level beginner

# Positioning and scenes, the HtDP way. Each expression on its own line is
# displayed in the interactions panel.

# overlay_xy moves the *second* image by (dx, dy). Negative offsets move it
# left / up, and the picture grows that way instead of cutting anything off.
overlay_xy(square(60, "solid", "red"), 20, 20, square(40, "solid", "blue"))
overlay_xy(square(60, "solid", "red"), -20, -20, square(40, "solid", "blue"))

# underlay_xy is the same, with the first image underneath.
underlay_xy(square(60, "outline", "black"), 15, 15, circle(20, "solid", "gold"))

# The align variants say which edges line up, instead of centering.
beside_align("bottom", rectangle(30, 60, "solid", "teal"), circle(15, "solid", "orange"))
above_align("left", rectangle(80, 20, "solid", "navy"), rectangle(30, 20, "solid", "skyblue"))
overlay_align("right", "top", square(70, "outline", "black"), square(25, "solid", "crimson"))

# A scene is a fixed-size canvas. place_image puts an image's *center* at a
# point on it, and anything past the edge is cropped away.
scene = empty_scene(200, 100)
place_image(circle(18, "solid", "purple"), 40, 50, scene)
place_image(circle(18, "solid", "purple"), 0, 0, scene)

# Two moons over a scene, built up one place_image at a time.
sky = place_image(circle(12, "solid", "gold"), 60, 30, empty_scene(200, 100))
place_image(circle(8, "solid", "silver"), 140, 60, sky)

# crop takes a rectangle out of an image; frame shows a bounding box.
crop(0, 0, 40, 40, star(40, "solid", "gold"))
frame(beside(circle(20, "solid", "red"), circle(20, "solid", "blue")))
