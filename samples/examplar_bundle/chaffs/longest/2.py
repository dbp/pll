# Plants: no empty case. `longest([])` raises ValueError.
#
# Needs a test for the empty list.


def initials(name):
    letters = [word[0].upper() for word in name.split()]
    return "".join(letter + "." for letter in letters)


def longest(words):
    return max(words, key=len)
