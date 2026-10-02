import { serializeFinding } from "./analyzers/findingLocation";
import { findRuntimeFinding } from "./analyzers/registry";
import { errorText } from "./errorText";
import { pythonErrorFrom } from "./errors/pythonError";
import type { Entry, ReactorPatch } from "./interactionsView";
import type { Level } from "./level";
import type { ReactorStepResult } from "./wire";
import type { ExecutionEvent, PythonRuntime } from "./types";
import {
  unavailableSocket,
  validateUniverseUrl,
  type UniverseConnect,
  type UniverseSocket,
  type UniverseStatus,
} from "./universeClient";

/** The program a run is running: what its errors are explained against. */
export interface ProgramInfo {
  source: string;
  fileName: string;
  level: Level;
}

/** An event to feed a reactor; mirrors `Reactor.react` in reactorLib.py. */
export type ReactorEvent =
  | { kind: "tick" }
  | { kind: "key"; key: string }
  | { kind: "mouse"; x: number; y: number; event: string }
  | { kind: "receive"; message: unknown };

/**
 * What the controller needs from whoever shows the reactors. `Owner` is
 * whatever a reactor belongs to - the editor's session - and is handed back
 * so the host knows where to show things.
 */
export interface ReactorHost<Owner> {
  runtime: PythonRuntime;
  connectUniverse: UniverseConnect;
  /** Show an entry where the owner's output goes. */
  append(owner: Owner, entry: Entry): void;
  /** Update a reactor's card in place. */
  patch(owner: Owner, id: string, patch: ReactorPatch): void;
  /** Run `task` in turn with everything else that uses the interpreter. */
  enqueue(task: () => Promise<void>): Promise<void>;
}

/**
 * Most messages a world may queue before its socket opens. A world that
 * sends on every tick to a server that never answers would otherwise grow
 * this without bound.
 */
const MAX_UNIVERSE_BACKLOG = 100;

interface ReactorDriver<Owner> {
  id: string;
  owner: Owner;
  /** The program that made it, so a handler's error is explained against it. */
  program: ProgramInfo;
  socket: UniverseSocket | null;
  status: UniverseStatus;
  /** Sent once the socket opens. */
  backlog: string[];
  /** Seconds between ticks, floored so a typo cannot busy-loop the host. */
  tickRate: number;
  ticking: boolean;
  playing: boolean;
  stopped: boolean;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
}

/**
 * Drives the reactors a run shows: their clocks, the controls and input
 * from their cards, and - for a world registered with a universe server -
 * the socket.
 *
 * The clock lives here rather than in Python: a loop in the worker would
 * hold it (and the exec chain) for the whole animation, which is the failure
 * `Stop` exists for. Each tick is one short request instead, so the prompt
 * stays usable while something is animating.
 */
export class ReactorController<Owner> {
  /** Reactors currently shown, keyed by the Python-side id. */
  private readonly reactors = new Map<string, ReactorDriver<Owner>>();

  constructor(private readonly host: ReactorHost<Owner>) {}

  /** Take ownership of a reactor the worker just showed. */
  start(owner: Owner, event: Extract<ExecutionEvent, { kind: "reactor" }>, program: ProgramInfo): void {
    const driver: ReactorDriver<Owner> = {
      id: event.id,
      owner,
      program,
      tickRate: Math.max(0.01, event.tickRate),
      ticking: event.ticking,
      playing: false,
      stopped: event.stopped,
      timer: null,
      inFlight: false,
      socket: null,
      status: "none",
      backlog: [],
    };
    this.reactors.set(event.id, driver);
    if (event.register) {
      this.connectUniverse(driver, event.register);
    }
    if (event.ticking && !event.stopped) {
      this.play(driver);
    }
  }

  /** From a card: play / pause / step / back / reset / scrub. */
  control(id: string, action: string, index?: number): void {
    const driver = this.reactors.get(id);
    if (!driver) return;
    if (action === "play") {
      this.play(driver);
      return;
    }
    if (action === "pause") {
      this.pause(driver);
      return;
    }
    if (action === "step") {
      this.pause(driver);
      void this.react(driver, { kind: "tick" });
      return;
    }
    if (action === "back" || action === "reset" || action === "seek") {
      this.pause(driver);
      void this.seek(driver, action === "reset" ? 0 : (index ?? 0));
    }
  }

  /** From a card: a key press or mouse event over the picture. */
  input(id: string, event: ReactorEvent): void {
    const driver = this.reactors.get(id);
    if (!driver || driver.stopped) return;
    void this.react(driver, event);
  }

  /** Stop and forget every reactor `owner` has, and tell Python to as well. */
  disposeAllFor(owner: Owner): void {
    for (const [id, driver] of [...this.reactors]) {
      if (driver.owner === owner) {
        this.dispose(id, { fromPython: true });
      }
    }
  }

  /** Stop every clock and close every socket; Python is going away too. */
  disposeAll(): void {
    for (const id of [...this.reactors.keys()]) {
      this.dispose(id, { fromPython: false });
    }
  }

  private dispose(id: string, opts: { fromPython: boolean }): void {
    const driver = this.reactors.get(id);
    if (!driver) return;
    this.pause(driver);
    if (driver.socket) {
      try {
        driver.socket.close();
      } catch {
        /* already gone */
      }
      driver.socket = null;
    }
    this.reactors.delete(id);
    if (opts.fromPython) {
      void this.host.runtime.reactorDispose(id).catch(() => undefined);
    }
  }

  private play(driver: ReactorDriver<Owner>): void {
    if (driver.playing || driver.stopped || !driver.ticking) return;
    driver.playing = true;
    driver.timer = setInterval(() => void this.react(driver, { kind: "tick" }), driver.tickRate * 1000);
    this.host.patch(driver.owner, driver.id, { playing: true });
  }

  private pause(driver: ReactorDriver<Owner>): void {
    if (driver.timer !== null) {
      clearInterval(driver.timer);
      driver.timer = null;
    }
    if (!driver.playing) return;
    driver.playing = false;
    this.host.patch(driver.owner, driver.id, { playing: false });
  }

  /**
   * Apply one event. Frames are *dropped* rather than queued while a step is
   * in flight: a slow `to_draw` should make the animation choppy, not build
   * a backlog that outlives the program.
   */
  private async react(driver: ReactorDriver<Owner>, event: ReactorEvent): Promise<void> {
    if (driver.inFlight || !this.reactors.has(driver.id)) return;
    driver.inFlight = true;
    try {
      await this.host.enqueue(async () => {
        const reply = await this.host.runtime.reactorStep(driver.id, JSON.stringify(event));
        this.apply(driver, reply);
      });
    } catch (err) {
      this.pause(driver);
      this.host.append(driver.owner, { kind: "stderr", text: `Reactor error: ${errorText(err)}` });
    } finally {
      driver.inFlight = false;
    }
  }

  private async seek(driver: ReactorDriver<Owner>, index: number): Promise<void> {
    try {
      await this.host.enqueue(async () => {
        const reply = await this.host.runtime.reactorSeek(driver.id, index);
        this.apply(driver, reply);
      });
    } catch (err) {
      this.host.append(driver.owner, { kind: "stderr", text: `Reactor error: ${errorText(err)}` });
    }
  }

  private apply(driver: ReactorDriver<Owner>, result: ReactorStepResult): void {
    if (result.gone) {
      this.dispose(driver.id, { fromPython: false });
      return;
    }
    if (!result.ok) {
      // A handler raised. Stop the clock and show it the same way any other
      // runtime error is shown, so the student sees where it happened.
      this.pause(driver);
      // Python always names the error; the fallback only satisfies the type.
      const error = pythonErrorFrom(result) ?? pythonErrorFrom({ error_type: "Error" })!;
      const { source, fileName, level } = driver.program;
      this.host.append(driver.owner, {
        kind: "finding",
        finding: serializeFinding(findRuntimeFinding(source, fileName, level, error)),
      });
      return;
    }
    this.host.patch(driver.owner, driver.id, {
      frame: result.frame,
      index: result.index,
      length: result.length,
      atEnd: result.at_end,
      stopped: result.stopped,
      valueRepr: result.value_repr,
    });
    if (result.messages && result.messages.length > 0) {
      this.send(driver, result.messages);
    }
    // Whether the frame on screen is a stopped one - not whether the
    // reactor ever stopped. Going back from the stopped frame is going back
    // to one that can go on, and Play has to be able to: a sticky flag left
    // Play enabled and doing nothing, while the step buttons still worked.
    driver.stopped = !!result.stopped;
    if (driver.stopped) {
      this.pause(driver);
    }
  }

  /* -------- Universe (world side only) -------- */

  private connectUniverse(driver: ReactorDriver<Owner>, url: string): void {
    const problem = validateUniverseUrl(url);
    if (problem) {
      this.setStatus(driver, "error", problem);
      return;
    }
    this.setStatus(driver, "connecting", url);
    const handlers = {
      onOpen: () => {
        this.setStatus(driver, "open", url);
        const queued = driver.backlog;
        driver.backlog = [];
        for (const json of queued) {
          driver.socket?.send(json);
        }
      },
      onMessage: (json: string) => {
        let message: unknown;
        try {
          message = JSON.parse(json);
        } catch {
          this.setStatus(driver, "error", "the server sent something that is not JSON");
          return;
        }
        void this.react(driver, { kind: "receive", message });
      },
      onClose: (reason: string) => this.setStatus(driver, "closed", reason),
      onError: (message: string) => this.setStatus(driver, "error", message),
    };
    try {
      driver.socket = this.host.connectUniverse(url, handlers);
    } catch (err) {
      driver.socket = unavailableSocket(handlers, errorText(err));
    }
  }

  private setStatus(driver: ReactorDriver<Owner>, status: UniverseStatus, detail: string): void {
    driver.status = status;
    this.host.patch(driver.owner, driver.id, { connection: status, connectionDetail: detail });
    if (status === "error") {
      this.host.append(driver.owner, { kind: "banner", text: `Universe server: ${detail}` });
    }
  }

  private send(driver: ReactorDriver<Owner>, messages: string[]): void {
    if (!driver.socket) {
      this.setStatus(
        driver,
        "error",
        "this reactor sent a message with package(...) but has no `register` address",
      );
      return;
    }
    if (driver.status === "open") {
      for (const json of messages) {
        driver.socket.send(json);
      }
      return;
    }
    // Still connecting: hold them, but not forever.
    for (const json of messages) {
      if (driver.backlog.length < MAX_UNIVERSE_BACKLOG) {
        driver.backlog.push(json);
      }
    }
  }
}
