#advanced

# Advanced mode = full Python. No static checks; reassignment, shadowing,
# shadowing builtins, and `global` / `nonlocal` are all permitted.

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
