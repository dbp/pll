# Plants: initials are not upper-cased. `initials("ada lovelace")` -> "a.l."
#
# Needs a test whose input is lower-case. A student who only ever writes
# "Ada Lovelace" will miss this one, which is the lesson.


def initials(name):
    return "".join(word[0] + "." for word in name.split())


def longest(words):
    best = ""
    for word in words:
        if len(word) > len(best):
            best = word
    return best
