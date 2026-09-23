# An Examplar bundle, as a course would author one

The assignment: `initials(name)` and `longest(words)`. The student's side of
it is [`../examplar.py`](../examplar.py) — tests and no implementation.

```
wheats/reference.py       known correct; every student test must pass on these
wheats/alternative.py     the same behaviour, written differently
chaffs/initials/1.py..3   known incorrect; each must be caught by some test
chaffs/longest/1.py..3
staff_tests.py            the course's own suite, for --verify
```

Build it, and check it, from the repo root:

```bash
node dist-cli/cli.cjs examplar build samples/examplar_bundle \
  -o /tmp/hw.json --verify samples/examplar_bundle/staff_tests.py
node samples/examplar_serve.mjs /tmp/hw.json
```

Then run `../examplar.py` in the editor. (Published, that first command is
`pll examplar build`.)

## Things worth copying

**Every wheat and chaff defines the same names.** A suite is run against all
of them interchangeably, so one missing a function would fail for a reason
that has nothing to do with the student. `build` refuses a bundle where they
disagree.

**A chaff goes in a directory named after the function it breaks.** The
student's report is one card per function, so `chaffs/longest/1.py` is how
you say that this one belongs on the `longest` card. Nothing can infer it —
a chaff is a whole file, and the functions it leaves alone still differ from
the wheat's by whitespace. Every function needs at least one, or its card
could never say anything about how thorough its tests are.

**Chaffs are numbered, not named.** A chaff's id is its filename, and it is
the *only* thing a student is told about one they missed. `off-by-one.py`
would hand over the test they were meant to write. Numbering restarts in
each directory, since the card is already about one function.

**One planted bug per chaff, and the rest correct.** `initials/2`,
`initials/3`, `longest/1` and `longest/2` are each caught by exactly one
test in `staff_tests.py`, so each demands a specific edge case: a lower-case
name, untidy spacing, a tie, an empty list. `initials/1` and `longest/3` are
caught by any test of their function at all, which is deliberate — a student
who has just started should not score zero on everything.

**`--verify` is not optional.** It checks the one property nothing else can:
your suite passes on every wheat and fails on every chaff. A chaff no test
can catch would silently never count for anybody, and a staff test that is
itself wrong shows up as a wheat failure with the assertion that proves it.
A function your own suite never tests fails too, since its chaffs are
unproven. Chaffs are only checked where the wheats pass, function by
function, since a suite that is wrong fails on everything.

**These sources stay with you.** Only bytecode goes into the bundle. They
live here because this is a sample; in a real course they belong in the staff
repository, not anywhere a student's folder can reach.
