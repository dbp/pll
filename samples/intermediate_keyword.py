#intermediate

# `global` and `nonlocal` are not allowed at the intermediate level.
# Pass values in as arguments and return new ones instead.

counter = 0


def bump():
    global counter
    counter += 1


def make_counter():
    n = 0

    def step():
        nonlocal n
        n += 1
        return n

    return step
