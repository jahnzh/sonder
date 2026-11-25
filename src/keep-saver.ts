/**
 * The saver of Keep on this device (#550, ADR 0018, ADR 0021): makes this device hold what each kept book needs.
 *
 * One tab of an account saves: the one holding the Web Lock `sonder-keep-saver:<user>`; it holds the lock while it is
 * open, and the next tab takes it over when it closes. The others pass their triggers to it over a channel and show
 * the same lines from the device database. A run is asked for when Sonder opens, returns to the foreground, comes back
 * online, after a library read that changed, and when the switch is turned on; never on a timer. A run first merges
 * the device's Keep records with the server's (when there is a connection), turns Keep on once for the books saved
 * before Keep existed, then saves the missing files of each kept book, one book after another: the recording's
 * tracks first, then the chosen EPUB, then the pair's reading sync map (#551), then the EPUB's prepared text (#805).
 * An EPUB, a text or a map that arrives later (a new chosen EPUB, a map that became ready, a map or a text prepared
 * again) is missing at the next run and saved then. Once Keep no longer keeps EPUB files (`KEEP_EPUB_FILE`, step 7
 * of #799), a kept EPUB from before is removed at the run that finds its prepared text complete.
 *
 * Network failures and a closed or frozen tab interrupt a save; it resumes by itself at the next run. A failed save
 * (the source refused, the account is signed out, the device is full) waits for Retry and is tried again by itself
 * only after a library read that changed (#552). A paused save waits for Resume: Pause writes `pausedAt` on the
 * book's Keep record, which every tab of the account reads, so Pause and Resume work from any tab. Everything outside this file (Dexie, the API, the lock, the channel, the file save) is
 * passed in, so the unit tests drive it with fakes. The server must not import this file.
 */
import type { DeviceSaveRecord } from "./device-saves";
import {
  KEEP_EPUB_FILE,
  classifyStop,
  keepRecording,
  keptNeeds,
  mergeKeep,
  rolloutChoices,
  type HeldEbook,
  type HeldFile,
  type HeldMap,
  type HeldPart,
  type HeldText,
  type KeepEntry,
  type KeepSend,
  type KeepWork,
  type KeptNeeds,
  type NeededTrack,
  type SaveStop,
  type ServerKeep,
  type StopCause,
} from "./keep";
import { rememberEbook, rememberRecording, turnedOffFromServer, type KeptRecording } from "./keep-device";
import { clearedMessageEnds, wasCleared, type DeviceHolds } from "./keep-cleared";

/** Why a run was asked for. */
export type KeepTrigger = "open" | "foreground" | "online" | "library" | "switch" | "retry";

/** A save running in this tab, as the screens show it. */
export type KeepJob = { progress: number; chapter: number; total: number; loaded: number; size: number };

export type SaverState = {
  works: KeepWork[];
  keep: KeepEntry[];
  downloads: HeldFile[];
  /**
   * Every `downloads` row, also one whose bytes do not add up (#554): any file of a book, complete or not, means the
   * browser did not clear it. Absent: `downloads`.
   */
  existingDownloads?: HeldFile[];
  /** Ebook editions with any copy here, kept or the reader's own (#554). */
  existingEbookIds?: string[];
  parts: HeldPart[];
  records: DeviceSaveRecord[];
  /** This device's kept EPUB copies (#551); not the reader's own reading cache. */
  ebooks?: HeldEbook[];
  /** This device's stored maps, by `reader-map:<ebookId>:<recordingId>`. */
  maps?: Record<string, HeldMap | undefined>;
  /** This device's kept prepared texts (#805). */
  texts?: HeldText[];
  /** This user's choice of edition on this device, by work. */
  ebookChoices?: Record<string, string | null | undefined>;
};

/** The record change a save writes (`writeDeviceSaveRecord`). */
export type RecordChange =
  | { state: "saving"; job?: KeepJob | null }
  | { state: "finished" }
  | SaveStop;

/** What the device holds of any book, for the cleared-device check (#554). */
function holdsOf(state: SaverState): DeviceHolds {
  return {
    keep: state.keep,
    works: state.works,
    records: state.records,
    downloads: state.existingDownloads ?? state.downloads,
    parts: state.parts,
    ebookIds: [...(state.existingEbookIds ?? []), ...(state.ebooks ?? []).map((ebook) => ebook.id), ...(state.texts ?? []).map((text) => text.id)],
    mapKeys: Object.keys(state.maps ?? {}),
  };
}

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
  /** Writes or clears `pausedAt` on a work's Keep record (#552). */
  writePause?: (workId: string, pausedAt: number | null) => Promise<void>;
  /** Whether a work's Keep record is paused now, read from the device database (another tab may have paused it). */
  isPaused?: (workId: string) => Promise<boolean>;
  /**
   * Whether a work's Keep record is on now, read from the device database (#707): Off may have been tapped after the
   * run read the records, and a save it starts or carries on then writes no file and no record.
   */
  isKept?: (workId: string) => Promise<boolean>;
  /** `navigator.storage.persist()`: asked only on the switch's tap. */
  persist: () => Promise<boolean>;
  /**
   * Stores the merged Keep records. A choice made on this device after the run read the records (a later `at`) stays
   * (#707, `keepStored`): the run's next pass sends it.
   */
  storeKeep: (records: KeepEntry[]) => Promise<void>;
  /** `GET /api/device/keep`; throws without a connection. */
  fetchKeep: () => Promise<ServerKeep[]>;
  /** Sends one choice or completion; answers the record as the server stores it. */
  sendKeep: (send: KeepSend) => Promise<ServerKeep>;
  /** Whether the rollout ran for this account on this device, and marking that it did. */
  rolloutDone: () => Promise<boolean>;
  markRolloutDone: () => Promise<void>;
  saveTrack: (track: NeededTrack, signal: AbortSignal, onProgress: (loaded: number, total: number) => void) => Promise<void>;
  /** Fetches an EPUB, fingerprints it on the device and keeps it (`saveEpubOffline`). */
  saveEbook?: (ebookId: string, signal: AbortSignal) => Promise<void>;
  /** Fetches and stores the pair's map (`warmMap`). */
  saveMap?: (ebookId: string, recordingId: string, signal: AbortSignal) => Promise<void>;
  /** Fetches and keeps an EPUB's prepared text: its manifest, parts and pictures (#805, `keepText`). */
  saveText?: (ebookId: string, signal: AbortSignal) => Promise<void>;
  /** Removes a kept EPUB file its prepared text replaced (#805), once Keep keeps no EPUB files. */
  dropEpub?: (ebookId: string) => Promise<void>;
  /** Whether Keep keeps the EPUB file beside the prepared text; `KEEP_EPUB_FILE` when absent. */
  keepEpub?: boolean;
  writeRecord: (recordingId: string, workId: string, change: RecordChange) => Promise<void>;
  /**
   * Removes every file of a book from this device (#553): a Keep record a merge turned off (Remove from library on
   * any device) frees its files at that run, as Off does.
   */
  removeWork?: (workId: string) => Promise<void>;
  /** Stores the recordings saved for a book on its Keep record (#553), so an earlier copy keeps its name. */
  remember?: (workId: string, saved: { recordings: KeptRecording[]; ebookIds: string[] }) => Promise<void>;
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
  /**
   * When this device noticed that the browser cleared Sonder's files (#554), and writing or ending it (null). This
   * device's note under Storage reads it.
   */
  clearedAt?: () => Promise<number | null>;
  setClearedAt?: (at: number | null) => Promise<void>;
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
  /**
   * The saves a network failure stopped in this run (device-downloads.spec.ts): the run's next pass, asked for while
   * it ran, does not try them again at once; the next run does, or a tap, or the connection coming back.
   */
  private networkStopped = new Set<string>();
  /** The connection came back since the last pass began: the next pass tries those saves again. */
  private backOnline = false;
  /** Books whose paused or failed save a tap asked to save again. */
  private forced = new Set<string>();
  /** A library read that changed asked for a run: a failed save is tried again by itself then (#552). */
  private libraryChanged = false;
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

  /**
   * Pause of a kept book (#552): `pausedAt` on its Keep record, so it waits for Resume in every tab and after a
   * reload, and the running save stops in whichever tab runs it.
   */
  async pauseWork(workId: string, saveId: string | null): Promise<void> {
    await this.deps.writePause?.(workId, this.now());
    if (saveId) this.pause(saveId);
  }

  /** Resume or Retry of a kept book: its pause is cleared and a run saves it again, in the tab that saves. */
  async resumeWork(workId: string): Promise<void> {
    await this.deps.writePause?.(workId, null);
    await this.trigger("retry", workId);
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
    if (reason === "library") this.libraryChanged = true;
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
    if (reason === "online") this.backOnline = true;
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
        this.networkStopped.clear();
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
    // A cleared device (#554): the server says this device completed a work it holds nothing of. It is noticed once,
    // when the device has read its library (a cleared device has none stored yet, and only the work names its files);
    // until then a server record of a completed work is not taken over, so the next run still sees nothing of it.
    if (!state.works.length) {
      const local = new Set(state.keep.map((entry) => entry.workId));
      server = server.filter((entry) => local.has(entry.workId) || !(entry.on && entry.completeAt !== null));
    }
    else if (this.deps.setClearedAt && server.some((entry) => wasCleared(entry, holdsOf(state))) && !(await this.deps.clearedAt?.())) {
      await this.deps.setClearedAt(this.now());
      this.changed();
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
    if (this.backOnline) this.networkStopped.clear();
    this.backOnline = false;
    let state = await this.deps.read();
    let { keep, synced } = await this.sync(state);
    // Turned off from the server (Remove from library, here or on another device): the files go now (#553).
    const removed = turnedOffFromServer(state.keep, keep);
    for (const workId of removed) {
      try {
        await this.deps.removeWork?.(workId);
      } catch {
        // Removed at a later run: the record is off, and Off's removal finds the files again.
      }
    }
    if (removed.length) {
      state = await this.deps.read();
      this.changed();
    }
    // The rollout needs the server's records first, so a choice made on the server (off) is not overwritten.
    // It also waits for a stored library: a device that has not read it yet cannot tell which saved books are in it.
    if (synced && state.works.length > 0 && !(await this.deps.rolloutDone())) {
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
    // The pauses as the device database holds them now: a merge's records may predate a pause in another tab.
    const pausedAt = new Map(state.keep.map((entry) => [entry.workId, entry.pausedAt ?? null]));
    const libraryChanged = this.libraryChanged;
    this.libraryChanged = false;
    for (const entry of keep) {
      if (this.stopped || !this.leader) return;
      if (!entry.on) continue;
      const work = works.get(entry.workId);
      if (!work || !work.inLibrary) continue;
      const needs = this.needsOf(work, state);
      const forced = this.forced.delete(entry.workId);
      // The kept recording is remembered on the record (#553): after a change of recording it is an earlier copy,
      // named even when its recording has left the library.
      // Its EPUB likewise, so Off finds it after the book left the stored library.
      const chosen = keepRecording(work);
      if (this.deps.remember) {
        const recordings = chosen ? rememberRecording(entry.recordings, { recordingId: chosen.recordingId, narrator: chosen.narrator ?? "" }) : entry.recordings ?? [];
        const edition = needs.ebook ?? needs.text;
        const ebookIds = edition ? rememberEbook(entry.ebookIds, edition.id) : entry.ebookIds ?? [];
        if (recordings !== entry.recordings || ebookIds !== entry.ebookIds) {
          entry.recordings = recordings;
          entry.ebookIds = ebookIds;
          await this.deps.remember(entry.workId, { recordings, ebookIds }).catch(() => {});
        }
      }
      await this.dropReplaced(needs);
      if (!needs.filesTotal) continue;
      if (needs.complete) {
        if (entry.completeAt === null) await this.reportComplete(entry, keep);
        continue;
      }
      // A book without a recording (only an ebook) has no save record of its own: its save is keyed by its EPUB.
      const saveId = needs.recordingId ?? `ebook:${(needs.ebook ?? needs.text)!.id}`;
      if (this.deps.running.has(saveId)) continue;
      const record = records.get(saveId);
      // A save the user paused waits for Resume; one that failed waits for Retry, or for a library read that changed.
      if (!forced && (entry.pausedAt || pausedAt.get(entry.workId) || record?.state === "paused")) continue;
      if (!forced && !libraryChanged && record?.state === "failed") continue;
      // Stopped by the network in this run's last pass: it would fail again now.
      if (!forced && this.networkStopped.has(saveId)) continue;
      if (!this.deps.online()) {
        // A save that was running when the tab closed is noted as such; it resumes when there is a connection.
        if (record?.state === "saving") await this.deps.writeRecord(saveId, work.workId, { state: "interrupted", how: "closed" });
        continue;
      }
      const save = () => this.save(work.workId, saveId, needs);
      const stop = this.deps.claim ? await this.deps.claim(saveId, save) : await save();
      if (stop === "busy") continue;
      if (stop === null) {
        state = await this.deps.read();
        const done = this.needsOf(works.get(entry.workId)!, state);
        await this.dropReplaced(done);
        if (done.complete) await this.reportComplete(entry, keep);
      } else if (stop.state === "interrupted" && stop.how === "network") {
        this.networkStopped.add(saveId);
        return; // The others would fail as well.
      }
    }
    // The note of a cleared device ends once every kept book is complete again (#554).
    if (this.deps.setClearedAt && (await this.deps.clearedAt?.())) {
      const latest = await this.deps.read();
      if (clearedMessageEnds(latest.keep, latest.works, (work) => this.needsOf(work, latest))) {
        await this.deps.setClearedAt(null);
        this.changed();
      }
    }
    void reason;
  }

  /** An EPUB file from before whose prepared text is complete: the text replaces it (#805), once Keep keeps no files. */
  private async dropReplaced(needs: KeptNeeds) {
    if (!needs.dropEpub || !this.deps.dropEpub) return;
    try {
      await this.deps.dropEpub(needs.dropEpub);
      this.changed();
    } catch {
      // Removed at a later run: the text is complete and the book reads from it meanwhile.
    }
  }

  private async reportComplete(entry: KeepEntry, keep: KeepEntry[]) {
    const completeAt = this.now();
    const local: KeepEntry = { ...entry, completeAt, completePending: true };
    let stored = local;
    if (this.deps.online()) {
      try {
        const answer = await this.deps.sendKeep({ workId: entry.workId, kind: "complete", completeAt });
        stored = { ...entry, ...answer, pending: false, completePending: false };
      } catch {
        // Told at the next run's merge.
      }
    }
    const index = keep.findIndex((e) => e.workId === entry.workId);
    if (index >= 0) keep[index] = stored;
    await this.deps.storeKeep(keep);
  }

  /** What a work needs on this device, from the device's state. */
  private needsOf(work: KeepWork, state: SaverState) {
    return keptNeeds(keepRecording(work), state.downloads, state.parts, {
      work: { ebooks: (work.ebooks ?? []) as never, chosenEbookId: work.chosenEbookId ?? null, readingSync: work.readingSync ?? [] },
      deviceChoice: state.ebookChoices?.[work.workId] ?? null,
      ebooks: state.ebooks ?? [],
      texts: state.texts ?? [],
      maps: state.maps ?? {},
    }, { keepEpub: this.deps.keepEpub ?? KEEP_EPUB_FILE });
  }

  /**
   * Saves the missing files of one kept book: its recording's tracks, then its EPUB, then its map, then its prepared
   * text (last, so a text the server cannot prepare leaves the rest saved). Null when every one
   * was saved, otherwise how it stopped. `saveId` is the recording (or, for a book with only an ebook, its EPUB).
   */
  private async save(workId: string, saveId: string, needs: KeptNeeds): Promise<SaveStop | null> {
    const controller: Stoppable = new AbortController();
    this.deps.running.set(saveId, controller);
    // A book with only an ebook keeps its record under its EPUB's save id, so a failure waits for Retry there too.
    const write = (change: RecordChange) => this.deps.writeRecord(saveId, workId, change);
    // Paused in another tab whose message did not reach this one: the Keep record says so before each file.
    // Off since the run read the records (#707): the save stops as Off stops it, writing nothing more.
    const pausedElsewhere = async () => {
      if (this.deps.isKept && !(await this.deps.isKept(workId).catch(() => true))) this.abort(controller, "off");
      else if (this.deps.isPaused && (await this.deps.isPaused(workId).catch(() => false))) this.abort(controller, "pause");
      controller.signal.throwIfAborted();
    };
    const missingIds = new Set(needs.missing.map((track) => track.id));
    const total = needs.filesTotal;
    let done = needs.filesSaved;
    const publish = (loaded: number, size: number) => {
      const share = size ? Math.min(1, loaded / size) : 0;
      const job: KeepJob = { progress: Math.min(100, ((done + share) / total) * 100), chapter: Math.min(total, done + 1), total, loaded, size };
      this.deps.onJob(saveId, job);
      void write({ state: "saving", job }).catch(() => {});
    };
    const step = () => {
      done++;
      publish(0, 0);
      this.changed();
    };
    try {
      // Before the first record: a save that Off overtook leaves none (#707).
      await pausedElsewhere();
      await write({ state: "saving", job: null });
      publish(0, 0);
      this.changed();
      for (const track of needs.tracks) {
        if (!missingIds.has(track.id)) continue;
        await pausedElsewhere();
        await this.deps.saveTrack(track, controller.signal, (loaded, size) => publish(loaded, size));
        step();
      }
      if (needs.ebook && !needs.ebook.complete && this.deps.saveEbook) {
        await pausedElsewhere();
        await this.deps.saveEbook(needs.ebook.id, controller.signal);
        step();
      }
      if (needs.map && !needs.map.complete && this.deps.saveMap) {
        await pausedElsewhere();
        await this.deps.saveMap(needs.map.ebookId, needs.map.recordingId, controller.signal);
        step();
      }
      if (needs.text && !needs.text.complete && this.deps.saveText) {
        await pausedElsewhere();
        await this.deps.saveText(needs.text.id, controller.signal);
        step();
      }
      await write({ state: "finished" });
      return null;
    } catch (error) {
      const stop = classifyStop({ cause: controller.signal.aborted ? controller.cause ?? "pause" : null, error });
      if (stop.state !== "off") await write(stop).catch(() => {});
      return stop;
    } finally {
      if (this.deps.running.get(saveId) === controller) this.deps.running.delete(saveId);
      this.deps.onJob(saveId, null);
      this.changed();
    }
  }
}
