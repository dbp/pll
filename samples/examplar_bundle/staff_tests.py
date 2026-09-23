# The course's own test suite, for `--verify`.
#
# This is not given to students - it is how you check the bundle itself. It
# has to pass on every wheat and fail on every chaff, which is the one
# property nothing else can check for you. A chaff no test can catch would
# silently never count for anybody, and a test of yours that is wrong shows
# up here as a wheat failure.
#
# Write it last, and write one test per line of the spec you handed out.


def test_initials_two_names():
    assert initials("Ada Lovelace") == "A.L."


def test_initials_one_name():
    assert initials("Grace") == "G."


def test_initials_upper_cases():
    assert initials("ada lovelace") == "A.L."


def test_initials_ignores_extra_spaces():
    assert initials("  Ada   Lovelace ") == "A.L."


def test_longest_picks_the_longest():
    assert longest(["cat", "hippo", "ox"]) == "hippo"


def test_longest_tie_keeps_the_first():
    assert longest(["cat", "dog"]) == "cat"


def test_longest_of_nothing():
    assert longest([]) == ""
