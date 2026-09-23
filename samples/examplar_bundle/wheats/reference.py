# A known correct implementation - a "wheat". Every test a student writes
# must pass on this, or their test expects the wrong answer.
#
# No `#level` line: these are compiled by `pll examplar build`, not run by
# PLL's level machinery, so a level would mean nothing here.


def initials(name):
    letters = [word[0].upper() for word in name.split()]
    return "".join(letter + "." for letter in letters)


def longest(words):
    best = ""
    for word in words:
        if len(word) > len(best):
            best = word
    return best
