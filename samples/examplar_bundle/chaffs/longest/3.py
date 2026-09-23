# Plants: returns the length of the longest word instead of the word.
# `longest(["cat", "hippo"])` -> 5
#
# Caught by any test of `longest`, for the same reason as chaffs/initials/1.


def initials(name):
    letters = [word[0].upper() for word in name.split()]
    return "".join(letter + "." for letter in letters)


def longest(words):
    best = ""
    for word in words:
        if len(word) > len(best):
            best = word
    return len(best)
