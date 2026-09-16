#level beginner

# Each name can only be assigned once per scope in beginner mode.

total = 0
total = total + 1     # error: `total` is already assigned

numbers = [1, 2, 3]
result = 0
for n in numbers:
    result += n       # error: `result` is reassigned in the loop body

print(result)
