/**
 * The saver of Keep on this device (#550, ADR 0018, ADR 0021): makes this device hold what each kept book needs.
 *
 * One tab of an account saves: the one holding the Web Lock `sonder-keep-saver:<user>`; it holds the lock while it is
 * open, and the next tab takes it over when it closes. The others pass their triggers to it over a channel and show
 * the same lines from the device database. A run is asked for when Sonder opens, returns to the foreground, comes back
 * online, after a library read that changed, and when the switch is turned on; never on a timer. A run first merges
 * the device's Keep records with the server's (when there is a connection), turns Keep on once for the books saved
 * before Keep existed, then saves the missing files of each kept book, one book after another.
 *
 * Network failures and a closed or frozen tab interrupt a save; it resumes by itself at the next run. A paused or
 * failed save waits for a tap. Everything outside this file (Dexie, the API, the lock, the channel, the file save) is
 * passed in, so the unit tests drive it with fakes. The server must not import this file.
 */
import type { DeviceSaveRecord } from "./device-saves";
import {
  classifyStop,
  keepRecording,
  keptNeeds,
  mergeKeep,
  rolloutChoices,
  type HeldFile,
  type HeldPart,
  type KeepEntry,
  type KeepSend,
  type KeepWork,
  type NeededTrack,
  type SaveStop,
  type ServerKeep,
  type StopCause,
} from "./keep";

/** Why a run was asked for. */
export type KeepTrigger = "open" | "foreground" | "online" | "library" | "switch" | "retry";

/** A save running in this tab, as the screens show it. */
export type KeepJob = { progress: number; chapter: number; total: number; loaded: number; size: number };

export type SaverState = {
  works: KeepWork[];
  keep: KeepEntry[];
  downloads: HeldFile[];
  parts: HeldPart[];
  records: DeviceSaveRecord[];
};

/** The record change a save writes (`writeDeviceSaveRecord`). */
export type RecordChange =
  | { state: "saving"; job?: KeepJob | null }
  | { state: "finished" }
  | SaveStop;

export type LockManager = {
  /** Calls `hold` once the lock is granted; the lock is held until `hold`'s promise settles. */
  request: (name: string, hold: () => Promise<void>) => Promise<unknown>;
};

export type SaverDeps = {
  account: number;
  locks: LockManager | null;
  /** The channel between this account's tabs; null where the browser has none. */
  channel: { post: (message: SaverMessage) => void; listen: (fn: (message: SaverMessage) => void) => () => void } | null;
  read: () => Promise<SaverState>;
  /** Stores a choice made on this device now, pending until the server answers it. */
  writeChoice: (workId: string, on: boolean) => Promise<void>;
  /** `navigator.storage.persist()`: asked only on the switch's tap. */
  persist: () => Promise<boolean>;
  /** Stores the merged Keep records. */
  storeKeep: (records: KeepEntry[]) => Promise<void>;
  /** `GET /api/device/keep`; throws without a connection. */
  fetchKeep: () => Promise<ServerKeep[]>;
  /** Sends one choice or completion; answers the record as the server stores it. */
  sendKeep: (send: KeepSend) => Promise<ServerKeep>;
  /** Whether the rollout ran for this account on this device, and marking that it did. */
  rolloutDone: () => Promise<boolean>;
  markRolloutDone: () => Promise<void>;
  saveTrack: (track: NeededTrack, signal: AbortSignal, onProgress: (loaded: number, total: number) => void) => Promise<void>;
  writeRecord: (recordingId: string, workId: string, change: RecordChange) => Promise<void>;
  online: () => boolean;
  /**
   * Runs `save` while this tab holds the recording's own lock, so no other tab (nor the app's own save button)
   * writes the same files at once; "busy" when another holds it.
   */
  claim?: (recordingId: string, save: () => Promise<SaveStop | null>) => Promise<SaveStop | null | "busy">;
  /** The saves running in this tab, by recording; shared with the app's own saves so they never overlap. */
  running: Map<string, AbortController>;
  /** A save's progress in this tab, or null when it ended. */
  onJob: (recordingId: string, job: KeepJob | null) => void;
  /** The device's files or records changed. */
  onChanged: () => void;
  now?: () => number;
};

export type SaverMessage =
  | { type: "trigger"; reason: KeepTrigger; workId?: string | null }
  | { type: "pause"; recordingId: string; cause?: StopCause }
  | { type: "changed" };

type Stoppable = AbortController & { cause?: StopCause };

export class KeepSaver {
  private leader = false;
  private stopped = false;
  private release: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  /** Books whose paused or failed save a tap asked to save again. */
  private forced = new Set<string>();
  private unlisten: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SaverDeps) {
    this.now = deps.now ?? Date.now;
  }

  get isLeader() {
    return this.leader;
  }

  /** Waits for the lock; the tab that holds it saves. Without Web Locks this tab saves on its own. */
  start(): void {
    this.unlisten = this.deps.channel?.listen((message) => this.receive(message)) ?? null;
    if (!this.deps.locks) {
      this.becomeLeader();
      return;
    }
    void this.deps.locks
      .request(`sonder-keep-saver:${this.deps.account}`, () => {
        if (this.stopped) return Promise.resolve();
        this.becomeLeader();
        return new Promise<void>((resolve) => (this.release = resolve));
      })
      .catch(() => {});
  }

  private becomeLeader() {
    this.leader = true;
    void this.run("open");
  }

  /** Stops saving in this tab (sign-out, a closed tab): running saves stop as `cause`, the lock goes. */
  stop(cause: StopCause = "closed"): void {
    this.stopped = true;
    this.leader = false;
    for (const controller of this.deps.running.values()) this.abort(controller, cause);
    this.release?.();
    this.release = null;
    this.unlisten?.();
    this.unlisten = null;
  }

  private abort(controller: Stoppable, cause: StopCause) {
    if (controller.signal.aborted) return;
    controller.cause = cause;
    controller.abort();
  }

  /** Stops the running save of a recording, in whichever tab runs it. */
  pause(recordingId: string, cause: StopCause = "pause"): void {
    const controller = this.deps.running.get(recordingId) as Stoppable | undefined;
    if (controller) this.abort(controller, cause);
    else this.deps.channel?.post({ type: "pause", recordingId, cause });
  }

  /**
   * The switch's tap: stores the choice and asks for a run that sends it (and, when on, saves the book). Turning it on
   * asks the browser to keep this site's storage; nothing else here does.
   */
  async tap(workId: string, on: boolean): Promise<void> {
    if (on) void this.deps.persist().catch(() => false);
    await this.deps.writeChoice(workId, on);
    void this.trigger("switch", on ? workId : null);
  }

  /** Asks for a run; `workId` names a book a tap asked for (its paused or failed save is saved again). */
  trigger(reason: KeepTrigger, workId?: string | null): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.leader) {
      this.deps.channel?.post({ type: "trigger", reason, workId: workId ?? null });
      return Promise.resolve();
    }
    if (workId && (reason === "switch" || reason === "retry")) this.forced.add(workId);
    return this.run(reason);
  }

  private receive(message: SaverMessage) {
    if (message.type === "changed") this.deps.onChanged();
    else if (message.type === "pause") {
      const controller = this.deps.running.get(message.recordingId) as Stoppable | undefined;
      if (controller) this.abort(controller, message.cause ?? "pause");
    } else if (message.type === "trigger" && this.leader) void this.trigger(message.reason, message.workId);
  }

  /** One run at a time; a run asked for while one runs runs once more after it. */
  private run(reason: KeepTrigger): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.runOnce(reason);
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private changed() {
    this.deps.onChanged();
    this.deps.channel?.post({ type: "changed" });
  }

  /** Merges with the server, then sends what the merge says to send. No connection: the device's records stand. */
  private async sync(state: SaverState): Promise<{ keep: KeepEntry[]; synced: boolean }> {
    if (!this.deps.online()) return { keep: state.keep, synced: false };
    let server: ServerKeep[];
    try {
      server = await this.deps.fetchKeep();
    } catch {
      return { keep: state.keep, synced: false };
    }
    const merged = mergeKeep(state.keep, server);
    const records = new Map(merged.records.map((record) => [record.workId, record]));
    for (const send of merged.send) {
      try {
        const answer = await this.deps.sendKeep(send);
        records.set(answer.workId, { ...answer, pending: false });
      } catch {
        // Sent again at the next run: the record stays pending.
      }
    }
    const keep = [...records.values()];
    await this.deps.storeKeep(keep);
    return { keep, synced: true };
  }

  private async runOnce(reason: KeepTrigger) {
    if (this.stopped) return;
    let state = await this.deps.read();
    let { keep, synced } = await this.sync(state);
    // The rollout needs the server's records first, so a choice made on the server (off) is not overwritten.
    if (synced && !(await this.deps.rolloutDone())) {
      const at = this.now();
      const turnOn = rolloutChoices({ works: state.works, keep, downloads: state.downloads, parts: state.parts });
      if (turnOn.length) {
        keep = [...keep, ...turnOn.map((workId) => ({ workId, on: true, at, completeAt: null, pending: true }))];
        await this.deps.storeKeep(keep);
        state = { ...state, keep };
        ({ keep } = await this.sync(state));
      }
      await this.deps.markRolloutDone();
    }
    const works = new Map(state.works.map((work) => [work.workId, work]));
    const records = new Map(state.records.map((record) => [record.recordingId, record]));
    for (const entry of keep) {
      if (this.stopped || !this.leader) return;
      if (!entry.on) continue;
      const work = works.get(entry.workId);
      if (!work || !work.inLibrary) continue;
      const recording = keepRecording(work);
      const needs = keptNeeds(recording, state.downloads, state.parts);
      const forced = this.forced.delete(entry.workId);
      if (!needs.recordingId || !needs.filesTotal) continue;
      if (needs.complete) {
        if (entry.completeAt === null) await this.reportComplete(entry, keep);
        continue;
      }
      if (this.deps.running.has(needs.recordingId)) continue;
      const record = records.get(needs.recordingId);
      // A save the user paused, or one the source refused, waits for a tap.
      if (!forced && (record?.state === "paused" || record?.state === "failed")) continue;
      if (!this.deps.online()) {
        // A save that was running when the tab closed is noted as such; it resumes when there is a connection.
        if (record?.state === "saving") await this.deps.writeRecord(needs.recordingId, work.workId, { state: "interrupted", how: "closed" });
        continue;
      }
      const recordingId = needs.recordingId;
      const save = () => this.save(work.workId, recordingId, needs.tracks, needs.missing);
      const stop = this.deps.claim ? await this.deps.claim(recordingId, save) : await save();
      if (stop === "busy") continue;
      if (stop === null) {
        state = await this.deps.read();
        const done = keptNeeds(keepRecording(works.get(entry.workId)!), state.downloads, state.parts);
        if (done.complete) await this.reportComplete(entry, keep);
      } else if (stop.state === "interrupted" && stop.how === "network") return; // The others would fail as well.
    }
    void reason;
  }

  private async reportComplete(entry: KeepEntry, keep: KeepEntry[]) {
    const completeAt = this.now();
    const local: KeepEntry = { ...entry, completeAt, completePending: true };
    let stored = local;
    if (this.deps.online()) {
      try {
        const answer = await this.deps.sendKeep({ workId: entry.workId, kind: "complete", completeAt });
        stored = { ...answer, pending: false };
      } catch {
        // Told at the next run's merge.
      }
    }
    const index = keep.findIndex((e) => e.workId === entry.workId);
    if (index >= 0) keep[index] = stored;
    await this.deps.storeKeep(keep);
  }

  /** Saves the missing tracks of one recording; null when every one was saved, otherwise how it stopped. */
  private async save(workId: string, recordingId: string, tracks: readonly NeededTrack[], missing: readonly NeededTrack[]): Promise<SaveStop | null> {
    const controller: Stoppable = new AbortController();
    this.deps.running.set(recordingId, controller);
    const missingIds = new Set(missing.map((track) => track.id));
    const total = tracks.length;
    let done = total - missing.length;
    const publish = (loaded: number, size: number) => {
      const share = size ? Math.min(1, loaded / size) : 0;
      const job: KeepJob = { progress: Math.min(100, ((done + share) / total) * 100), chapter: Math.min(total, done + 1), total, loaded, size };
      this.deps.onJob(recordingId, job);
      void this.deps.writeRecord(recordingId, workId, { state: "saving", job }).catch(() => {});
    };
    try {
      await this.deps.writeRecord(recordingId, workId, { state: "saving", job: null });
      publish(0, 0);
      this.changed();
      for (const track of tracks) {
        if (!missingIds.has(track.id)) continue;
        controller.signal.throwIfAborted();
        await this.deps.saveTrack(track, controller.signal, (loaded, size) => publish(loaded, size));
        done++;
        publish(0, 0);
        this.changed();
      }
      await this.deps.writeRecord(recordingId, workId, { state: "finished" });
      return null;
    } catch (error) {
      const stop = classifyStop({ cause: controller.signal.aborted ? controller.cause ?? "pause" : null, error });
      if (stop.state !== "off") await this.deps.writeRecord(recordingId, workId, stop).catch(() => {});
      return stop;
    } finally {
      if (this.deps.running.get(recordingId) === controller) this.deps.running.delete(recordingId);
      this.deps.onJob(recordingId, null);
      this.changed();
    }
  }
}
