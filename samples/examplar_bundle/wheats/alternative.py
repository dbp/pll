# A second known correct implementation, written differently on purpose.
#
# One wheat is enough to catch a test that expects the wrong answer. A
# second one catches a test that happens to depend on *how* the first is
# written - iteration order, a mutated argument, a particular exception
# type. Tests that pass on both are testing the behaviour, not the code.


def initials(name):
    result = ""
    for word in name.split():
        result = result + word[0].upper() + "."
    return result


def longest(words):
    if len(words) == 0:
        return ""
    # `sorted` is stable, so a tie keeps the word that came first.
    return sorted(words, key=len, reverse=True)[0]
