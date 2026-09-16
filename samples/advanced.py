#level advanced

# Advanced: no static checks. Reassignment, shadowing, shadowing builtins,
# and `global` / `nonlocal` are all permitted. Type annotations are still
# checked as the program runs, but by Python's own rules - so `True` counts
# as 1 here, unlike at beginner / intermediate. For no checks at all, see
# raw.py.

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
