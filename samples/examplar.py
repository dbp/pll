#level beginner
#examplar http://localhost:8123/hw.json

# Writing the tests *first*.
#
# There is no implementation in this file, and that is the point. The
# `#examplar` line above names a bundle of implementations the course wrote:
# some known to be correct, some known to be wrong. Every time you run this
# file, PLL checks your tests against all of them. You get one card per
# function, each answering two questions about your tests of it: are they
# right, and are they thorough?
#
# The functions being tested:
#
#     initials(name)
#       "Ada Lovelace"       -> "A.L."
#       "ada lovelace"       -> "A.L."     initials are upper-cased
#       "Grace"              -> "G."
#       "  Ada   Lovelace "  -> "A.L."     extra spaces are ignored
#
#     longest(words)
#       ["cat", "hippo", "ox"] -> "hippo"
#       ["cat", "dog"]         -> "cat"     a tie keeps the first
#       []                     -> ""
#
# To run this sample you need the bundle served somewhere. From the repo
# root:
#
#     pnpm run build
#     node dist-cli/cli.cjs examplar build samples/examplar_bundle -o /tmp/hw.json
#     node samples/examplar_serve.mjs /tmp/hw.json
#
# then run this file. The three tests below are all correct, but they only
# cover the easy cases - so each card will say so, and name the buggy
# implementations of that function which got past them. Filling the gaps is
# the exercise: read the table above and write a test for each line of it.
#
# Without the server the bundle cannot be fetched, and PLL falls back to
# running these tests against this file - where the functions do not exist,
# so all three report a NameError. That is the fallback saying the bundle is
# missing, not the feature; start the server and run again.


def test_initials_two_names():
    assert initials("Ada Lovelace") == "A.L."


def test_initials_one_name():
    assert initials("Grace") == "G."


def test_longest_picks_the_longest():
    assert longest(["cat", "hippo", "ox"]) == "hippo"
