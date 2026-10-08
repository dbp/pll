#!/usr/bin/env node
/**
 * Integration smoke for stopping a running program: boots the built desktop
 * worker, starts an infinite loop, and interrupts it through the shared
 * buffer. Requires `pnpm run build` so dist/desktop/pyodideWorker.js exists.
 *
 * This is the one test that proves the whole path, because the failure it
 * guards against (the worker never returning) cannot be reproduced with a
 * fake runtime.
 */
import { expect, passed } from "./lib/check.mjs";
import { importSource } from "./lib/bundle.mjs";
import { INDEX_URL } from "./lib/pyodide.mjs";
import { startWorker, talk } from "./lib/worker.mjs";

// The real module, bundled, so this test uses the same layout and the same
// retrying Stop as the hosts, rather than a copy that could pass while the
// code it covers is broken.
const {
  INTERRUPT_SAB_BYTES,
  INTERRUPT_SIGINT,
  INTERRUPT_ACK_INDEX,
  requestInterrupt,
} = await importSource('export * from "./src/common/interruptBuffer";\n');

/** Generous: a bytecode check is immediate, so this only bounds a failure. */
const INTERRUPT_DEADLINE_MS = 20000;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Reject rather than hang forever if the interrupt never lands. */
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_res, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} did not finish within ${ms}ms`)), ms);
    }),
  ]);
}

async function main() {

  console.log("\n[0] a Stop is retried until it is acknowledged, and no longer");
  {
    // Deterministic, with no worker: the race that erases a Stop happens
    // inside Pyodide and is too rare to hit on purpose, so the retry is
    // checked on its own, case by case.
    const fresh = () => {
      const sab = new SharedArrayBuffer(INTERRUPT_SAB_BYTES);
      return { sab, view: new Uint8Array(sab) };
    };

    // Wiped, as Pyodide's check wipes it: put back.
    {
      const { sab, view } = fresh();
      requestInterrupt(sab, () => true, 5, 1000);
      Atomics.store(view, 0, 0);
      await sleep(40);
      expect(Atomics.load(view, 0) === INTERRUPT_SIGINT, "a wiped Stop should be re-asserted");
    }
    // Acknowledged: left alone, so nothing more reaches PLL's clean-up.
    {
      const { sab, view } = fresh();
      requestInterrupt(sab, () => true, 5, 1000);
      Atomics.store(view, INTERRUPT_ACK_INDEX, 1);
      Atomics.store(view, 0, 0);
      await sleep(40);
      expect(Atomics.load(view, 0) === 0, "an acknowledged Stop must not be re-asserted");
    }
    // The work it was for has finished: nothing carries into the next run.
    {
      const { sab, view } = fresh();
      let running = true;
      requestInterrupt(sab, () => running, 5, 1000);
      running = false;
      Atomics.store(view, 0, 0);
      await sleep(40);
      expect(Atomics.load(view, 0) === 0, "a Stop must not outlive the work it was for");
    }
    // A fresh press clears the last one's acknowledgement.
    {
      const { sab, view } = fresh();
      Atomics.store(view, INTERRUPT_ACK_INDEX, 1);
      requestInterrupt(sab, () => false);
      expect(Atomics.load(view, INTERRUPT_ACK_INDEX) === 0, "a new press starts unacknowledged");
      expect(Atomics.load(view, 0) === INTERRUPT_SIGINT, "and stores the signal at once");
    }
    // Out of time: stops trying (a loop inside C code never acknowledges).
    {
      const { sab, view } = fresh();
      requestInterrupt(sab, () => true, 5, 30);
      await sleep(60);
      Atomics.store(view, 0, 0);
      await sleep(40);
      expect(Atomics.load(view, 0) === 0, "retries end at the limit");
    }
    console.log("    re-asserted when wiped; left alone once acknowledged, finished or out of time");
  }

  const interruptBuffer = new SharedArrayBuffer(INTERRUPT_SAB_BYTES);
  /** A Stop as the hosts send one: retried until acknowledged, while `run` lasts. */
  const stop = (run) => {
    let settled = false;
    run.then(
      () => (settled = true),
      () => (settled = true),
    );
    requestInterrupt(interruptBuffer, () => !settled);
  };
  /** One bare store, with nothing retrying it - a Stop racing the end of a run. */
  const signal = () => Atomics.store(new Uint8Array(interruptBuffer), 0, INTERRUPT_SIGINT);
  /**
   * A Stop as the hosts send one, pressed when no Python was running to take
   * it and with nothing left to retry for - pressed while files loaded, or
   * as a run ended. Unlike `signal`, this clears the acknowledgement left by
   * the last Stop that landed, as every real press does; with it still set,
   * PLL's handler swallows the signal as a repeat, and a test that a stale
   * Stop is dropped would pass whether it was dropped or not.
   */
  const staleStop = () => requestInterrupt(interruptBuffer, () => false);
  /** Python checks for a signal only now and then, so give it time to look. */
  const POLLS = "total = 0\nfor i in range(300000):\n    total += i\n";
  const pending = () => Atomics.load(new Uint8Array(interruptBuffer), 0);

  const worker = startWorker();
  const session = talk(worker);

  try {
    console.log("\n[1] worker init accepts an interrupt buffer");
    await session.send({ type: "init", indexUrl: INDEX_URL, interruptBuffer });
    console.log("    ok");

    console.log("\n[2] an infinite loop is interruptible");
    const run = session.send({
      type: "runFile",
      code: 'print("before")\nwhile True:\n    pass\n',
      fileName: "loop.py",
      sessionKey: "s1",
      level: "raw",
    });
    // Proof the loop is running, rather than a hopeful sleep.
    await session.waitForOutput("before");
    stop(run);
    const { result } = await withDeadline(run, INTERRUPT_DEADLINE_MS, "interrupted run");
    expect(result.ok === false, `interrupted run should not be ok, got ok=${result.ok}`);
    expect(
      result.error_type === "KeyboardInterrupt",
      `expected KeyboardInterrupt, got ${result.error_type}`,
    );
    expect(
      result.stdout.includes("before"),
      `output printed before the loop should survive, got ${JSON.stringify(result.stdout)}`,
    );
    console.log(`    error_type=${result.error_type} stdout=${JSON.stringify(result.stdout)}`);

    console.log("\n[3] the interpreter still works after an interrupt");
    const after = await withDeadline(
      session.send({
        type: "runFile",
        code: 'print("still here")\n',
        fileName: "after.py",
        sessionKey: "s1",
        level: "raw",
      }),
      INTERRUPT_DEADLINE_MS,
      "post-interrupt run",
    );
    expect(after.result.ok === true, `run after an interrupt should succeed: ${after.result.traceback}`);
    expect(after.result.stdout.includes("still here"), "post-interrupt stdout should be captured");
    console.log("    ok");

    console.log("\n[4] a Stop nobody consumed does not fire into the next run");
    // Pressed with nothing running, as happens when Stop races the end of a run.
    staleStop();
    expect(pending() === INTERRUPT_SIGINT, "the signal should be pending before the next run");
    const later = await withDeadline(
      session.send({
        type: "runFile",
        code: `${POLLS}print("clean")\n`,
        fileName: "clean.py",
        sessionKey: "s1",
        level: "raw",
      }),
      INTERRUPT_DEADLINE_MS,
      "run after a stale signal",
    );
    expect(
      later.result.ok === true,
      `a stale Stop must not interrupt the next program: ${later.result.error_type}`,
    );
    expect(later.result.stdout.includes("clean"), "post-stale-signal stdout should be captured");
    console.log("    ok");
    console.log("\n[5] a loop that prints is interruptible, and does not flood the host");
    // The case that matters: every print calls back into JS, so without
    // coalescing this posts a few hundred thousand messages a second and the
    // host never gets around to processing the student's Stop.
    const before = session.displays.length;
    const printRun = session.send({
      type: "runFile",
      code: 'while True:\n    print("hello")\n',
      fileName: "noisy.py",
      sessionKey: "s1",
      level: "raw",
    });
    await session.waitForOutput("hello");
    // Now that it is definitely running, measure a second of it.
    await sleep(1000);
    const duringSecond = session.displays.length - before;
    stop(printRun);
    const noisy = await withDeadline(printRun, INTERRUPT_DEADLINE_MS, "interrupted print loop");
    expect(
      noisy.result.error_type === "KeyboardInterrupt",
      `expected KeyboardInterrupt, got ${noisy.result.error_type}`,
    );
    expect(
      noisy.result.stdout.includes("hello"),
      "the loop's output should still be captured",
    );
    // One second of output is at most about 110 messages: a line each, up to
    // `LIVE_LINES_PER_SECOND` (100) and a burst of 10, then one per 50ms.
    // Allow slack; the point is that it is bounded by time, not by how fast
    // Python can print.
    expect(
      duringSecond <= 200,
      `one second of printing should coalesce into few messages, got ${duringSecond}`,
    );
    console.log(`    messages for 1s of printing: ${duringSecond} (uncoalesced was ~230000)`);

    console.log("\n[6] a Stop overwritten by Pyodide's own check is re-asserted");
    // Pyodide's check reads the signal and then writes 0 over it, as two
    // steps, so a Stop stored between them is erased - about one Stop in
    // twenty to forty in a freshly started worker. The race is too rare to
    // hit on purpose, so do exactly what the check does instead: store the
    // Stop, then wipe it. Only the retry can bring it back.
    const ATTEMPTS = 5;
    let lost = 0;
    for (let i = 0; i < ATTEMPTS; i++) {
      const marker = `go${i}`;
      const attempt = session.send({
        type: "runFile",
        code: `print("${marker}")\nwhile True:\n    pass\n`,
        fileName: "again.py",
        sessionKey: "s1",
        level: "raw",
      });
      await session.waitForOutput(marker);
      stop(attempt);
      // The clobber, as `_Py_CheckEmscriptenSignals_Helper` does it.
      Atomics.store(new Uint8Array(interruptBuffer), 0, 0);
      try {
        const { result } = await withDeadline(attempt, 5000, `attempt ${i}`);
        if (result.error_type !== "KeyboardInterrupt") lost++;
      } catch {
        lost++;
        break; // the worker is stuck in the loop; nothing after this can run
      }
    }
    expect(lost === 0, `${lost} of ${ATTEMPTS} wiped Stops were never re-asserted`);
    console.log(`    ${ATTEMPTS - lost} of ${ATTEMPTS} wiped Stops still stopped the program`);

    console.log("\n[7] a retried Stop does not leak into the next program");
    const next = await withDeadline(
      session.send({
        type: "runFile",
        code: 'total = 0\nfor i in range(200000):\n    total = total + i\nprint("finished", total)\n',
        fileName: "next.py",
        sessionKey: "s1",
        level: "raw",
      }),
      INTERRUPT_DEADLINE_MS,
      "run after many stops",
    );
    expect(
      next.result.ok === true && next.result.stdout.includes("finished"),
      `the next program must run to the end: ${next.result.error_type ?? "ok"}`,
    );
    console.log("    ok");

    console.log("\n[8] a program that caught the first Stop can be stopped by the next");
    // The acknowledgement is per press: a repeat of a delivered Stop is
    // consumed, so it cannot fire into PLL's clean-up - but a new press
    // starts over, or a program that catches KeyboardInterrupt and carries
    // on could never be stopped again.
    const stubborn = session.send({
      type: "runFile",
      code: [
        "import time",
        "try:",
        '    print("first loop")',
        "    while True:",
        "        pass",
        "except KeyboardInterrupt:",
        '    print("caught it")',
        // Output is coalesced and only sent on a later write, so pause past
        // the flush interval and write again to get "caught it" out.
        "started = time.time()",
        "while time.time() - started < 0.2:",
        "    pass",
        'print("second loop")',
        "while True:",
        "    pass",
      ].join("\n"),
      fileName: "stubborn.py",
      sessionKey: "s1",
      level: "raw",
    });
    let stubbornSettled = false;
    stubborn.then(() => (stubbornSettled = true), () => (stubbornSettled = true));
    await session.waitForOutput("first loop");
    stop(stubborn);
    await session.waitForOutput("second loop");
    expect(session.streamed.includes("caught it"), "the program caught the first Stop");
    // Stray repeats of the delivered Stop, as a retry racing the
    // acknowledgement would store: each must be consumed, not raised. Stored
    // again and again, because a single store can be erased by the very race
    // this file is about - and a repeat that never arrives proves nothing.
    for (let i = 0; i < 30; i++) {
      if (pending() === 0) signal();
      await sleep(10);
    }
    expect(
      Atomics.load(new Uint8Array(interruptBuffer), INTERRUPT_ACK_INDEX) === 1,
      "the first Stop should be acknowledged",
    );
    expect(!stubbornSettled, "a repeat of a delivered Stop must be consumed, not raised");
    // A new press stops it.
    stop(stubborn);
    const stubbornResult = await withDeadline(stubborn, INTERRUPT_DEADLINE_MS, "second stop");
    expect(
      stubbornResult.result.error_type === "KeyboardInterrupt",
      `the second press should stop it, got ${stubbornResult.result.error_type}`,
    );
    console.log("    the repeat was consumed; the next press stopped it");

    console.log("\n[9] a Stop during the tests ends them");
    {
      // A Stop ends the tests, rather than counting as one test's error:
      // every test after it could loop as well.
      await session.send({ type: "loadPytest" });
      const code = [
        "def double(n):",
        "    return n * 2",
        "",
        "",
        "def test_double():",
        "    assert double(2) == 4",
        "",
        "",
        "def test_forever():",
        "    while True:",
        "        pass",
        "",
        "",
        "def test_after():",
        "    assert double(3) == 6",
      ].join("\n");
      const tests = session.send({
        type: "runFile",
        withTests: true,
        code,
        fileName: "tests.py",
        sessionKey: "s1",
        level: "raw",
      });
      // Test output is not streamed, so there is nothing to wait for: give
      // the run time to reach the loop. The retry delivers the Stop
      // whenever Python next runs, so the exact moment does not matter.
      await sleep(1500);
      stop(tests);
      const { result: ran } = await withDeadline(tests, INTERRUPT_DEADLINE_MS, "stopped tests");
      expect(ran.ok === true, `the program itself finished: ${ran.error_type}`);
      const result = ran.tests ?? {};
      expect(result.stopped === true, `the tests should be marked stopped: ${JSON.stringify(result.stopped)}`);
      expect(result.stopped_in === "test_forever", `stopped in the looping test: ${result.stopped_in}`);
      const names = (result.tests ?? []).map((t) => `${t.name}:${t.outcome}`);
      expect(
        names.join(",") === "test_double:passed,test_forever:stopped",
        `the test before it kept its result, and the one after never ran: ${names.join(",")}`,
      );
      expect(result.errors === 0 && result.failed === 0, "a Stop is counted as neither a failure nor an error");
      console.log(`    ${names.join(", ")}; test_after not run`);

      // Stopped in the program's own top-level code: the tests never start.
      const looping = session.send({
        type: "runFile",
        withTests: true,
        code: "while True:\n    pass\n\n\ndef test_never():\n    assert True\n",
        fileName: "top.py",
        sessionKey: "s1",
        level: "raw",
      });
      await sleep(500);
      stop(looping);
      const top = await withDeadline(looping, INTERRUPT_DEADLINE_MS, "stopped program");
      expect(top.result.error_type === "KeyboardInterrupt", `the program was stopped: ${top.result.error_type}`);
      expect(top.result.tests == null, `and no test ran: ${JSON.stringify(top.result.tests)}`);
      console.log("    and in the program itself, before any test");
    }

    console.log("\n[10] a Stop nobody took does not reach the next run's checks");
    {
      // Pressed while files loaded, so no Python was running to take it and
      // the run ended at the editor's next check. The next run starts with
      // its static checks, not the program, so they are what would raise
      // it: "Static analysis failed: KeyboardInterrupt".
      for (const request of [
        { type: "staticAnalyze", code: POLLS, level: "beginner", fileName: "a.py", sessionKey: null },
        { type: "hasTests", code: `${POLLS}def test_a():\n    pass\n` },
        { type: "checkSyntax", code: "x = 1" },
      ]) {
        staleStop();
        let failure = null;
        await session.send(request).catch((err) => (failure = err.message));
        expect(failure === null, `${request.type} should ignore an old Stop, got ${failure}`);
      }
      console.log("    static checks, the test check and the prompt's syntax check all ran");
    }

    console.log("\n[11] a Stop that lands while the file is prepared is still a Stop");
    {
      // Long enough to prepare that the retry lands while PLL is still
      // parsing and instrumenting it, outside the `except` that reports a
      // Stop in the student's code - from where it could escape as an
      // error, shown as "Internal error: KeyboardInterrupt".
      const big =
        Array.from({ length: 4000 }, (_, i) => `def f${i}(n):\n    return n + ${i}\n`).join("\n") +
        "\ndef test_a():\n    assert f1(1) == 2\n";
      for (const [type, withTests] of [["runFile", true], ["runFile", false], ["replEval", false]]) {
        const run = session.send({ type, withTests, code: big, fileName: "big.py", sessionKey: "s1", level: "raw" });
        stop(run);
        let failure = null;
        const reply = await withDeadline(run, INTERRUPT_DEADLINE_MS, `early stop of ${type}`).catch(
          (err) => {
            failure = err.message.split("\n").at(-1) || err.message;
            return null;
          },
        );
        expect(failure === null, `${type} should report the Stop, not fail: ${failure}`);
        if (reply === null) continue;
        expect(
          reply.result.error_type === "KeyboardInterrupt",
          `${type} should say it was stopped: ${JSON.stringify(reply.result).slice(0, 200)}`,
        );
      }
      console.log("    a program with tests, one without, and a prompt line each came back stopped");
    }

    console.log("\n[12] one Stop ends an Examplar check, however many implementations it has");
    {
      // The check runs the student's tests once per implementation. A Stop
      // recorded as one test's error would let the next implementation run
      // the same looping test again - one press per implementation.
      const built = await session.send({
        type: "examplarBuild",
        sources: JSON.stringify({
          wheats: {
            reference: "def shout(w):\n    return w.upper() + '!'\n",
            alternative: "def shout(w):\n    return (w + '!').upper()\n",
          },
          chaffs: { shout: { 1: "def shout(w):\n    return w\n" } },
        }),
      });
      expect(built.result?.ok === true, `the bundle builds: ${JSON.stringify(built.result?.error)}`);
      const check = session.send({
        type: "examplarRun",
        testSource: "def test_shout():\n    while True:\n        pass\n",
        bundle: JSON.stringify(built.result.bundle),
        fileName: "hw.py",
      });
      await sleep(1000);
      stop(check);
      let failure = null;
      await withDeadline(check, INTERRUPT_DEADLINE_MS, "stopped Examplar check").catch(
        (err) => (failure = err.message),
      );
      expect(failure !== null && /KeyboardInterrupt/.test(failure), `the check ends as a Stop: ${failure}`);
      console.log("    stopped once, and the second implementation never ran its loop");
    }
  } finally {
    await worker.terminate();
  }

  if (!passed()) {
    console.error("\nsmoke-interrupt: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-interrupt: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
