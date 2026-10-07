import { loadBundle, parseExamplarDirective, type BundleStore } from "./examplarSource";
import type { ExamplarOutcome } from "./fromPython";
import type { PythonRuntime } from "./types";
import { errorText } from "./errorText";
import { StoppedError } from "./runtimeErrors";

/**
 * The Examplar step of a run, and the cards it produces: the student's tests
 * judged against known correct and known incorrect implementations.
 *
 * Shared by every host. The editor draws the cards in the panel and the
 * command line prints them, but both show the same lines, worded here.
 */

/** A test that raised, with the message it raised. */
export interface ExamplarTestFailure {
  test: string;
  message: string;
}

/**
 * One part of a card's body. A `line` is a sentence; an `item` names one
 * test or implementation under the line before it, with `detail` only where
 * saying more reveals nothing about the answer.
 */
export type ExamplarBlock =
  | { kind: "line"; tone: "good" | "bad" | "warn" | "note"; text: string }
  | { kind: "item"; tone: "bad" | "warn"; name: string; detail?: string };

/**
 * One Examplar verdict, as its own card.
 *
 * A card per **function**, because that is the unit a student works in.
 * Within it, two phases that answer different questions and mean opposite
 * things: *are your tests for this function right?*, judged against correct
 * implementations, and *are they thorough?*, judged against buggy ones. The
 * second waits for the first, per function - a wrong test of `initials`
 * says nothing about how well `longest` is tested and must not hold its
 * report back.
 *
 * Neither half says more than it has to. A disagreement gives the test's
 * name, not its assertion, because `assert 'HI!' == 'hi!'` states the
 * correct answer - a student could read the specification off this card one
 * deliberately-wrong test at a time. A buggy implementation that got
 * through gives its id, because its failure message describes the bug it
 * plants. Both are the same rule: say which thing is wrong, never what is
 * right.
 */
export type ExamplarEntry = ExamplarFunctionEntry | ExamplarFailedEntry;

interface ExamplarEntryBase {
  kind: "examplar";
  /** Where the implementations came from; shown as the header's tooltip. */
  url: string;
  /** True when the bundle came from the store rather than the network. */
  cached: boolean;
  /** The card's lines, in order: what every view shows. */
  body: ExamplarBlock[];
}

/** How one provided function's tests fared. */
export interface ExamplarFunctionEntry extends ExamplarEntryBase {
  card: "function";
  /** The provided function this card is about. Heads the card. */
  name: string;
  /** How many of the student's tests exercise it. Zero is the tests-first state. */
  testCount: number;
  /** True when all of them passed on every correct implementation. */
  allPass: boolean;
  /**
   * Names - and only names - of tests whose expectation is wrong. The
   * assertion is deliberately absent; see the note above.
   */
  failures: string[];
  /**
   * Tests that raised, so they never got as far as an expectation. These
   * do keep their message: `FileNotFoundError: ... 'data.csv'` says why the
   * student's own test could not run and reveals nothing about the answer.
   */
  errors: ExamplarTestFailure[];
  /** Why those could not run, when it is worth explaining. */
  hint?: string;
  /** Buggy implementations of this function, and how many were caught. */
  total: number;
  caught: number;
  /** Ids - and only ids - of the ones no test caught. */
  missed: string[];
  /** True when phase one has not passed here, so coverage was not measured. */
  pending: boolean;
}

/** Neither phase ran anywhere: the bundle would not have it. */
export interface ExamplarFailedEntry extends ExamplarEntryBase {
  card: "failed";
  problem: string;
}

/** How the step reports, in whichever host runs it. */
export interface ExamplarHost {
  say(text: string, kind: "note" | "problem"): void;
  status(text: string): void;
  examplarCard(entry: ExamplarEntry): void;
  stopRequested(): boolean;
}

/**
 * Run the file's `#examplar` check. Null when the file asks for none; false
 * when its own tests should not run after it; true when they should.
 *
 * Examplar runs whenever the directive is present - writing tests before
 * any implementation of their own is the point, not a special case. What
 * the answer decides is only whether the *other* test phase makes sense:
 * running a file's `test_*` against the code in that same file needs that
 * code to exist, or every test reports a NameError under a perfectly good
 * verdict. Nothing is said about its absence, because early on absence is
 * the normal state.
 *
 * The implementations run with **no files** in the work directory. A bundle
 * is code fetched from a URL, and although a course is trusted there is no
 * reason for it to be able to read - or rewrite - the student's data files.
 * The run plan mounts them only after this step, and the directory is
 * emptied here first (`mountWorkspaceFiles([])`), since it can still hold
 * the last run's; if that fails, the check is not run.
 */
export async function runExamplarStep(
  runtime: PythonRuntime,
  bundles: BundleStore,
  host: ExamplarHost,
  code: string,
  fileName: string,
): Promise<boolean | null> {
  const bundle = await fetchBundle(bundles, host, code);
  if (bundle === null) {
    return null;
  }
  host.status("Checking your tests...");
  try {
    await runtime.mountWorkspaceFiles([]);
  } catch (err) {
    if (!(err instanceof StoppedError)) {
      host.examplarCard(
        failedCard(
          bundle,
          `the known implementations were not run: your files could not be set aside first (${errorText(err)})`,
        ),
      );
    }
    return false;
  }
  // Not for the messages - the card deliberately shows none - but because
  // a student's own tests may `import pytest` for `pytest.approx`, which
  // the README recommends for comparing floats. Without it that import
  // raises, the definition is skipped, and every test using it reports as
  // one that could not run.
  try {
    await runtime.ensurePytest();
  } catch {
    /* float comparisons may misreport; the rest of the verdict stands */
  }
  if (host.stopRequested()) {
    return false;
  }
  let result: ExamplarOutcome;
  try {
    result = await runtime.examplarRun(code, bundle.json, fileName);
  } catch (err) {
    // A Stop is not a reason the check failed; the run plan says it.
    if (!(err instanceof StoppedError)) {
      host.examplarCard(failedCard(bundle, errorText(err)));
    }
    return false;
  }
  for (const entry of buildExamplarEntries(bundle, result)) {
    host.examplarCard(entry);
  }
  const provides = result.provides ?? [];
  const defines = result.wheats?.[0]?.studentDefines ?? [];
  return provides.length > 0 && provides.every((name) => defines.includes(name));
}

interface Bundle {
  url: string;
  json: string;
  cached: boolean;
}

/**
 * The bundle the file's directive names, or null. Every failure here is said
 * and gives null: a missing or unreachable bundle must not stop the file
 * from running, the same fail-open stance as the type checker's.
 */
async function fetchBundle(bundles: BundleStore, host: ExamplarHost, code: string): Promise<Bundle | null> {
  const directive = parseExamplarDirective(code);
  if (directive.kind === "none") {
    return null;
  }
  if (directive.kind === "error") {
    host.say(`Line ${directive.line}: ${directive.message}`, "problem");
    return null;
  }
  host.status("Loading implementations...");
  const load = await loadBundle(directive.url, bundles);
  if (load.note) {
    host.say(`Known implementations: ${load.note}`, "note");
  }
  if (!load.json) {
    host.say(`Could not load the known implementations from ${directive.url}: ${load.error}`, "problem");
    return null;
  }
  return { url: directive.url, json: load.json, cached: load.fromCache };
}

function failedCard(bundle: Bundle, problem: string): ExamplarFailedEntry {
  return {
    kind: "examplar",
    url: bundle.url,
    cached: bundle.cached,
    card: "failed",
    problem,
    body: [{ kind: "line", tone: "bad", text: problem }],
  };
}

/**
 * Turn a raw Examplar result into cards - one per provided function.
 *
 * Two summarising decisions live here. A test that fails on *any* correct
 * implementation is reported once: the student needs to know the test is
 * wrong, not which of several equivalent references disagreed. And a buggy
 * implementation contributes only its id, because its failure messages
 * describe the bug it plants.
 */
export function buildExamplarEntries(bundle: Bundle, result: ExamplarOutcome): ExamplarEntry[] {
  if (!result.ok) {
    return [failedCard(bundle, result.error ?? "the known implementations could not be run")];
  }
  // Something stuck ends the whole check: nothing after it was run, and
  // nothing before it can be trusted to stand alone.
  if (result.timedOut) {
    return [failedCard(bundle, timedOutProblem(result.timedOut))];
  }
  const wheats = result.wheats ?? [];
  // Only the bundle can fail to load, so this is a message for whoever
  // built it rather than for the student. A buggy one that does not load
  // would otherwise count as caught, by every test.
  const unloadable =
    wheats.find((w) => !w.loaded) ?? (result.chaffs ?? []).find((c) => !c.loaded);
  if (unloadable) {
    const which = unloadable.targets === undefined ? "correct" : "buggy";
    return [
      failedCard(
        bundle,
        `a known ${which} implementation could not be loaded ` +
          `(${unloadable.errorType}: ${unloadable.errorMessage}). ` +
          `The bundle may need rebuilding.`,
      ),
    ];
  }

  // Two different verdicts, because they are two different lessons. A test
  // that *fails* an assertion on a correct implementation expects the wrong
  // answer. A test that *raises* did not get far enough to have an opinion -
  // most often because the phase runs with the workspace unmounted, so a
  // file it opens is not there. Saying "you expect the wrong answer" over a
  // `FileNotFoundError` would be an accusation, and a false one.
  const disagreed = new Set<string>();
  const raised = new Map<string, string>();
  for (const wheat of wheats) {
    for (const [test, outcome] of Object.entries(wheat.tests)) {
      if (outcome.outcome === "fail") {
        disagreed.add(test);
      } else if (outcome.outcome === "error" && !raised.has(test)) {
        raised.set(test, shownError(outcome.message ?? outcome.outcome));
      }
    }
  }
  // The student's definitions that could not load here, for the hint: a
  // file or module of theirs that is not there during the check.
  const unloadedFiles = (wheats[0]?.unloaded ?? []).filter((u) => isFileAccessError(u.error));
  // A test that disagrees with one reference and raises on another is a
  // disagreement: that is the half the student can act on.
  for (const test of disagreed) {
    raised.delete(test);
  }

  const attribution = result.attribution ?? {};
  const chaffs = result.chaffs ?? [];
  const skipped = new Set(result.chaffsSkipped ?? []);
  return (result.provides ?? []).map((name) => {
    const tests = Object.entries(attribution)
      .filter(([, names]) => names.includes(name))
      .map(([test]) => test);
    const failures = tests.filter((test) => disagreed.has(test));
    const errors = tests
      .filter((test) => raised.has(test))
      .map((test) => ({ test, message: raised.get(test) as string }));
    const mine = chaffs.filter((c) => c.targets === name);
    const missed = mine
      .filter((c) => c.loaded && Object.values(c.tests).every((t) => t.outcome === "pass"))
      .map((c) => c.id);
    const card = {
      kind: "examplar" as const,
      url: bundle.url,
      cached: bundle.cached,
      card: "function" as const,
      name,
      testCount: tests.length,
      allPass: tests.length > 0 && failures.length === 0 && errors.length === 0,
      failures,
      errors,
      hint:
        errors.length > 0 && (errors.some((e) => isFileAccessError(e.message)) || unloadedFiles.length > 0)
          ? UNMOUNTED_HINT +
            unloadedFiles.map((u) => ` Line ${u.line} could not run here: ${u.error}.`).join("")
          : undefined,
      total: mine.length,
      caught: mine.length - missed.length,
      missed,
      // The primitive gates phase two per function, so `mine` is normally
      // already empty here. Deciding again from this function's own verdict
      // rather than trusting the flag keeps a coverage number from ever
      // appearing beside a test that did not pass.
      pending: failures.length > 0 || errors.length > 0 || skipped.has(name),
    };
    return { ...card, body: cardBody(card) };
  });
}

/** What a function's card says, line by line. */
function cardBody(card: Omit<ExamplarFunctionEntry, "body">): ExamplarBlock[] {
  if (card.testCount === 0) {
    return [{ kind: "line", tone: "note", text: "No tests yet." }];
  }
  const CORRECT = "Against correct implementations: ";
  const BUGGY = "Against buggy implementations: ";
  const total = card.testCount;
  /** "your test" when there is one of them, "2 of your 5 tests" otherwise. */
  const some = (n: number) => (total === 1 ? "your test" : `${n} of your ${total} tests`);
  /** English needs the verb to agree with that. */
  const does = (n: number) => (n === 1 ? "s" : "");

  const body: ExamplarBlock[] = [];
  if (card.allPass) {
    body.push({
      kind: "line",
      tone: "good",
      text: total === 1 ? `${CORRECT}your test passes.` : `${CORRECT}all ${total} of your tests pass.`,
    });
  }
  if (card.failures.length > 0) {
    const n = card.failures.length;
    body.push({ kind: "line", tone: "bad", text: `${CORRECT}${some(n)} expect${does(n)} the wrong answer:` });
    // The name, and nothing else. The assertion would state the correct
    // answer, which would let a student read the specification off this
    // card one deliberately-wrong test at a time.
    for (const test of card.failures) {
      body.push({ kind: "item", tone: "bad", name: test });
    }
  }
  // Separate, and worded as a fact rather than a fault: a test that raised
  // never got as far as having an expectation, so telling the student it
  // expects the wrong answer would be wrong.
  if (card.errors.length > 0) {
    body.push({ kind: "line", tone: "warn", text: `${CORRECT}${some(card.errors.length)} could not run here:` });
    for (const { test, message } of card.errors) {
      body.push({ kind: "item", tone: "warn", name: test, detail: message });
    }
    if (card.hint) body.push({ kind: "line", tone: "note", text: card.hint });
  }
  if (card.pending) {
    body.push({ kind: "line", tone: "note", text: `${BUGGY}waiting until all your tests of ${card.name} pass.` });
  } else if (card.caught === card.total) {
    body.push({ kind: "line", tone: "good", text: `${BUGGY}caught all ${card.total}.` });
  } else {
    body.push({
      kind: "line",
      tone: "warn",
      text: `${BUGGY}caught ${card.caught} of ${card.total} - missed ${card.missed.join(", ")}.`,
    });
  }
  return body;
}

/**
 * Why a test that opens a file cannot run during the phase.
 *
 * Shown only when a test actually tripped over it, because out of that
 * context it is a confusing thing to read: the file plainly *is* next to
 * their program, and it works everywhere else.
 */
const UNMOUNTED_HINT =
  "Your tests are checked on their own, so files next to your program are not " +
  "available while that happens.";

/** True for the errors Python raises when a file or module is not there to be opened. */
function isFileAccessError(message: string): boolean {
  return /^(FileNotFoundError|IsADirectoryError|NotADirectoryError|PermissionError|ModuleNotFoundError|ImportError):/.test(
    message,
  );
}

/**
 * What of an error raised in the student's own code a card may show. Its
 * type always; its message only when it cannot carry what the implementation
 * gave back - a file or name of theirs that is not there. `int(convert(x))`
 * raising "invalid literal for int(): 'abc'" would put the correct answer on
 * the card.
 */
function shownError(message: string): string {
  if (isFileAccessError(message) || /^(NameError|UnboundLocalError):/.test(message)) {
    return message;
  }
  return message.split(":")[0];
}

/** What to say when something ran past the time a test is given. */
function timedOutProblem(stuck: NonNullable<ExamplarOutcome["timedOut"]>): string {
  const against = stuck.kind === "wheat" ? "a known correct implementation" : "a known buggy implementation";
  if (stuck.test === null) {
    return `Loading your definitions with ${against} took more than ${stuck.seconds} seconds, so the check stopped.`;
  }
  return (
    `\`${stuck.test}\` ran for more than ${stuck.seconds} seconds against ${against}, so the check stopped. ` +
    (stuck.kind === "wheat"
      ? "A test that runs that long is usually stuck in a loop."
      : "That implementation may never finish on what this test gives it; tell your course staff.")
  );
}
