#expert

# Expert mode = full Python. No static checks; reassignment, shadowing,
# shadowing builtins are all permitted.

total = 0
for n in [1, 2, 3, 4, 5]:
    total = total + n
print(total)


list = [10, 20, 30]
print(sum(list))
