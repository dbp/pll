#level intermediate

# Intermediate still flags shadowing of an outer binding (or a built-in),
# the same way beginner does.

count = 0


def increment(value):
    # `count` here shadows the outer `count` defined above.
    count = value + 1
    return count


# Shadowing a Python built-in is also flagged.
list = [1, 2, 3]
print(list)
