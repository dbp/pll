#level beginner

# Names like `circle` and `rectangle` are provided by the PLL image
# library in every file, so defining your own with the same name is
# shadowing - exactly like redefining a built-in like `list`.


# The image library already defines `rectangle`; this shadows it.
def rectangle(width, height):
    return width * height


print(rectangle(30, 40))

# The table library already defines `table`; this shadows it too.
table = 5

# Calling the library's functions is, of course, fine.
wheel = circle(25, "solid", "gray")
print(image_width(wheel))
