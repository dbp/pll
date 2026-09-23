# Plants: `>=` instead of `>`, so a tie keeps the *last* longest word.
# `longest(["cat", "dog"])` -> "dog"
#
# Needs a test where two words tie. This is the classic one students miss:
# every example they think of has a single clear winner.


def initials(name):
    letters = [word[0].upper() for word in name.split()]
    return "".join(letter + "." for letter in letters)


def longest(words):
    best = ""
    for word in words:
        if len(word) >= len(best):
            best = word
    return best
