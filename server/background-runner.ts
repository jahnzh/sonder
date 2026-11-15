/**
 * One runner for the background loops (ADR 0010, #392). A feature declares its loop next to its own code: the
 * interval, the tick, and the pause switch that holds it. The runner starts the loops, skips a tick while the
 * switch or its environment flag holds the loop (`isHeld`), never runs two ticks of one loop at once, and stops
 * every loop when the app closes. Pausing means "start no new work": a tick that is already running finishes.
 *
 * A feature function that is also called outside its loop (an enqueue, a route) keeps its own pause check, so
 * a direct call honours the switch too.
 */
import type { FastifyInstance } from "fastify";
import { isHeld as heldBySwitch } from "./activity-pause.ts";
import type { PausableProcess } from "./activity-pause-model.ts";

export type BackgroundProcess = {
  /** Unique per app; the pause switch id where the loop has one. */
  id: string;
  intervalMs: number;
  /** Also tick once when the loop starts, not only after the first interval. */
  runAtStart?: boolean;
  /** The switch that holds the loop. Without one the loop always ticks. */
  pausedBy?: PausableProcess;
  /** Runs once when the loop is added, before its first tick. */
  start?: () => void;
  /**
   * One round of work. A returned promise is the running tick: the next one waits for it. A tick that only
   * starts work with its own guard returns nothing. A tick handles and reports its own errors; what escapes
   * goes to `onError` (the app logs it at debug level, where the loops used to drop it silently).
   */
  tick: () => unknown;
  /** Runs when the app closes, right after the loop's timer is cleared. */
  stop?: () => void;
};

export type BackgroundOptions = {
  /** Tests: loops that never tick on their own (every loop, or these ids). `tick(id)` still runs them. */
  manual?: true | readonly string[];
  /** Tests: replaces the pause switches and environment flags. */
  isHeld?: (id: PausableProcess) => boolean;
  /** Tests: replaces the real timers. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** An error that escaped a tick. */
  onError?: (id: string, error: unknown) => void;
};

export type TickResult = "ran" | "held" | "busy" | "stopped";

type Loop = { process: BackgroundProcess; timer: ReturnType<typeof setInterval> | null; running: boolean };

export class BackgroundRunner {
  private loops: Loop[] = [];
  private stopped = false;
  constructor(private options: BackgroundOptions = {}) {}

  /** Starts a loop: its start hook, its timer, then its immediate run where it has one. */
  add(process: BackgroundProcess) {
    if (this.loops.some((loop) => loop.process.id === process.id))
      throw new Error(`The background loop "${process.id}" is already running.`);
    const loop: Loop = { process, timer: null, running: false };
    this.loops.push(loop);
    process.start?.();
    const manual = this.options.manual;
    if (manual === true || manual?.includes(process.id) || this.stopped) return;
    loop.timer = (this.options.setInterval ?? setInterval)(() => void this.run(loop), process.intervalMs);
    loop.timer.unref();
    if (process.runAtStart) void this.run(loop);
  }

  /** Tests: run one tick now, through the same pause and overlap checks as the timer. */
  tick(id: string) {
    const loop = this.loops.find((candidate) => candidate.process.id === id);
    if (!loop) return Promise.reject(new Error(`No background loop "${id}".`));
    return this.run(loop);
  }

  /** The loops in start order (shutdown runs in reverse). */
  processes() {
    return this.loops.map((loop) => loop.process);
  }

  /** Clears each loop's timer and runs its stop hook, last started first. Running ticks are not awaited. */
  stop() {
    this.stopped = true;
    for (const loop of [...this.loops].reverse()) {
      if (loop.timer) (this.options.clearInterval ?? clearInterval)(loop.timer);
      loop.timer = null;
      loop.process.stop?.();
    }
  }

  private async run(loop: Loop): Promise<TickResult> {
    if (this.stopped) return "stopped";
    if (loop.running) return "busy";
    const { pausedBy } = loop.process;
    // Reading the pause switch reads the database: a failure there is an error of this round, like one in the
    // tick. Nothing may escape, because the timer discards this promise and an unhandled rejection ends the server.
    try {
      if (pausedBy && (this.options.isHeld ?? heldBySwitch)(pausedBy)) return "held";
    } catch (error) {
      this.options.onError?.(loop.process.id, error);
      return "held";
    }
    loop.running = true;
    try {
      await loop.process.tick();
    } catch (error) {
      this.options.onError?.(loop.process.id, error);
    } finally {
      loop.running = false;
    }
    return "ran";
  }
}

const runners = new WeakMap<FastifyInstance, BackgroundRunner>();

/**
 * The app's runner, created on first use with `options`; it stops with the app. createApp creates it before
 * any feature adds a loop, so the options reach every loop.
 */
export function backgroundRunner(app: FastifyInstance, options?: BackgroundOptions) {
  let runner = runners.get(app);
  if (runner) return runner;
  runner = new BackgroundRunner({
    onError: (id, error) => app.log.debug({ error, loop: id }, "Background tick failed"),
    ...options,
  });
  runners.set(app, runner);
  const created = runner;
  app.addHook("onClose", async () => created.stop());
  return runner;
}
