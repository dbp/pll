#level beginner

# `count` here is fine - it's defined once at the top level.
count = 0


def increment(value):
    # This `count` is a new name of the function's, which hides the outer
    # `count`: shadowing.
    count = value + 1
    return count


# Shadowing a Python built-in is also flagged.
list = [1, 2, 3]
print(list)
