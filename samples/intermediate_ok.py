#intermediate

# Intermediate mode allows rebinding *inside functions* so for-loop
# accumulator patterns work, while still keeping shadowing rules and
# disallowing the `global` / `nonlocal` keywords.


def total_of(numbers):
    total = 0
    for n in numbers:
        total = total + n
    return total


def biggest(numbers):
    best = numbers[0]
    for n in numbers[1:]:
        if n > best:
            best = n
    return best


print(total_of([1, 2, 3, 4, 5]))
print(biggest([7, 1, 9, 3, 4]))
