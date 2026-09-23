# Plants: splits on single spaces, so runs of spaces produce empty words.
# `initials("  Ada   Lovelace ")` raises IndexError.
#
# Needs a test with untidy input. A crash counts as caught - the test told
# this implementation apart from a correct one, which is all that is asked.


def initials(name):
    return "".join(word[0].upper() + "." for word in name.split(" "))


def longest(words):
    best = ""
    for word in words:
        if len(word) > len(best):
            best = word
    return best
