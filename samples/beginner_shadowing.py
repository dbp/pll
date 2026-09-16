#level beginner

# `count` here is fine - it's defined once at the top level.
count = 0


def increment(value):
    # This `count` shadows the outer `count` and is also a reassignment.
    # Beginner mode flags the shadowing first.
    count = value + 1
    return count


# Shadowing a Python built-in is also flagged.
list = [1, 2, 3]
print(list)
