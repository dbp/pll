#level advanced

# Advanced: reassignment, shadowing, shadowing builtins, `global` /
# `nonlocal` and `del` of a name are all permitted. The one check before the
# run is for names used where they have no value, as at every level but raw.
# Type annotations are still checked as the program runs, but by Python's
# own rules - so `True` counts as 1 here, unlike at beginner / intermediate.
# For no checks at all, see raw.py.

total = 0
for n in [1, 2, 3, 4, 5]:
    total = total + n
print(total)


list = [10, 20, 30]
print(sum(list))


counter = 0


def bump():
    global counter
    counter += 1


bump()
bump()
print("counter:", counter)
