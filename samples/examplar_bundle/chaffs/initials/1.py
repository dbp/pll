# Plants: the last initial has no dot. `initials("Ada Lovelace")` -> "A.L"
#
# Caught by any test of `initials` at all, which is why it is worth having:
# a student who has just started should not score zero on everything and be
# unable to tell which chaffs they are close to.


def initials(name):
    letters = [word[0].upper() for word in name.split()]
    return ".".join(letters)


def longest(words):
    best = ""
    for word in words:
        if len(word) > len(best):
            best = word
    return best
