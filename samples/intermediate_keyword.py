#level intermediate

# `global` and `nonlocal` are not allowed at the intermediate level: pass
# values in as arguments and return new ones instead. Nor is removing a
# name with `del` - which, below, would not even leave anything out.

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


def without_negatives(numbers):
    for n in numbers:
        if n < 0:
            del n
    return numbers
