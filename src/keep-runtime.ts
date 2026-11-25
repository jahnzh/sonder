/**
 * Keep on this device in the browser (#550): the saver of `keep-saver.ts` wired to the account's device database,
 * the API, Web Locks, a BroadcastChannel and today's `downloadInChunks`, and what the screens read of it.
 *
 * The server must not import this file: the production image copies only four files of `src/`.
 */
import { useEffect, useState } from "react";
import type { DeviceSaveRecord } from "./device-saves";
import { keepRecording, keepStored, keptNeeds, readerFileKey, readerMapKey, readerTextKey, type KeptNeeds, type HeldEbook, type HeldMap, type KeepEntry, type KeepSend, type SaveStop, type ServerKeep, type StopCause } from "./keep";
import { warmMap } from "./alignment-map-lifecycle";
import { alignmentMapDeps } from "./alignment-map-deps";
import { deviceEbookChoice, ebookDeviceCopySize } from "./ebook-device-copy";
import { isKeptReaderFile, type ReaderFileRecord } from "./ebook-keep";
import { loadReader, saveEpubOffline } from "./reading";
import { KeepSaver, type KeepJob, type KeepTrigger, type LockManager, type SaverMessage } from "./keep-saver";
import { accountDatabase, api, authDB, deleteDownloads, downloadTrack, getDownloadedBlob, listDeviceSaveRecords, listOfflineEbookCopies, listOfflineEbookEditionIds, localDB, removeOfflineEbook, writeDeviceSaveRecord } from "./lib";
import { deviceBook, type DeviceBook } from "./keep-device";
import { keepText, keptTextSize, listKeptTexts, removeKeptText } from "./keep-text-store";
import { removeEbookFromDevice } from "./ebook-device-copy";
import type { Download, DownloadPart, LibraryWork, Track } from "./types";
import { EBOOK_DEVICE_EVENT } from "./reading";

/** Fired when this account's Keep records on this device changed. */
export const KEEP_EVENT = "sonder:keep-changed";
const ROLLOUT_KEY = "keep-rollout";
const CLEARED_KEY = "keep-cleared-at";

/** The saves running in this tab, by recording: the saver's and the app's own, so they never overlap. */
export const activeSaves = new Map<string, AbortController>();

const jobListeners = new Set<(recordingId: string, job: KeepJob | null) => void>();
/** Follows the saves running in this tab. */
export function onKeepJob(listener: (recordingId: string, job: KeepJob | null) => void): () => void {
  jobListeners.add(listener);
  return () => jobListeners.delete(listener);
}

function webLocks(): (LockManager & { claim: (name: string, run: () => Promise<unknown>) => Promise<boolean> }) | null {
  const locks = (navigator as Navigator & { locks?: { request: (...args: unknown[]) => Promise<unknown> } }).locks;
  if (!locks?.request) return null;
  return {
    request: (name, hold) => locks.request(name, hold),
    claim: async (name, run) => {
      let granted = false;
      await locks.request(name, { ifAvailable: true }, async (lock: unknown) => {
        if (!lock) return;
        granted = true;
        await run();
      });
      return granted;
    },
  };
}

/**
 * Runs a save of a recording while this tab holds its own lock; false (and nothing run) when another tab, or
 * another save in this one, holds it. Without Web Locks it runs.
 */
export async function claimRecording<T>(recordingId: string, save: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const locks = webLocks();
  if (!locks) return { ran: true, value: await save() };
  let value: T | undefined;
  const ran = await locks.claim(`sonder-save:${recordingId}`, async () => {
    value = await save();
  });
  return ran ? { ran: true, value: value as T } : { ran: false };
}

let saver: KeepSaver | null = null;
let saverAccount: number | null = null;
let unwire: (() => void) | null = null;

/** The saver of the signed-in account, once started. */
export function keepSaver(): KeepSaver | null {
  return saver;
}

function keepChanged() {
  window.dispatchEvent(new Event(KEEP_EVENT));
}

/** Starts the saver for `account` (once per account), with its triggers: foreground, online and a changed library. */
export function startKeepSaver(account: number): KeepSaver {
  if (saver && saverAccount === account) return saver;
  stopKeepSaver();
  // This account's device database, fixed now: a write must not follow a sign-in as another account.
  const { db } = accountDatabase();
  const locks = webLocks();
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(`sonder-keep:${account}`) : null;
  const created = new KeepSaver({
    account,
    locks,
    channel: channel && {
      post: (message) => channel.postMessage(message),
      listen: (fn) => {
        const receive = (event: MessageEvent<SaverMessage>) => fn(event.data);
        channel.addEventListener("message", receive);
        return () => channel.removeEventListener("message", receive);
      },
    },
    read: async () => {
      const rows = await localDB.downloads.toArray();
      const downloads = [];
      // Today's size check: a file counts only while its stored bytes add up to its size.
      for (const row of rows) if (await getDownloadedBlob(row.trackId)) downloads.push({ trackId: row.trackId, recordingId: row.recordingId, size: row.size });
      const works = (await db.works.toArray()) as LibraryWork[];
      return {
        works,
        keep: await db.keep.toArray(),
        downloads,
        existingDownloads: rows.map((row) => ({ trackId: row.trackId, recordingId: row.recordingId, size: row.size })),
        // Any copy of an EPUB, the reader's own too, in either database (#554): the browser did not clear that book.
        existingEbookIds: await listOfflineEbookEditionIds().catch(() => [] as string[]),
        parts: await localDB.downloadParts.toArray(),
        records: await listDeviceSaveRecords().catch(() => [] as DeviceSaveRecord[]),
        ...(await readingHeld(works)),
      };
    },
    writeChoice: (workId, on) => writeChoice(workId, on),
    writePause: async (workId, pausedAt) => {
      await db.transaction("rw", db.keep, async () => {
        const entry = await db.keep.get(workId);
        if (entry) await db.keep.put({ ...entry, pausedAt });
      });
      keepChanged();
    },
    isPaused: async (workId) => !!(await db.keep.get(workId))?.pausedAt,
    isKept: async (workId) => (await db.keep.get(workId))?.on !== false,
    persist: askPersist,
    storeKeep: async (records) => {
      await db.transaction("rw", db.keep, async () => {
        // A pause belongs to the pause and resume writers (#552): a merge that read the records before another tab
        // paused or resumed must not undo it. A record that turned off has no pause.
        const stored = new Map((await db.keep.bulkGet(records.map((r) => r.workId))).flatMap((e) => (e ? [[e.workId, e] as const] : [])));
        const next = records.map((merged) => {
          // A choice tapped after the run read the records stays as it is (#707).
          const record = keepStored(merged, stored.get(merged.workId));
          if (record !== merged) return record;
          const pausedAt = record.on ? stored.get(record.workId)?.pausedAt ?? null : null;
          // The recordings saved here (#553) belong to `remember`, likewise.
          const recordings = record.recordings ?? stored.get(record.workId)?.recordings;
          const ebookIds = record.ebookIds ?? stored.get(record.workId)?.ebookIds;
          return { ...record, pausedAt, ...(recordings ? { recordings } : {}), ...(ebookIds ? { ebookIds } : {}) };
        });
        await db.keep.bulkPut(next);
      });
      keepChanged();
    },
    fetchKeep: async () => (await api<{ records: ServerKeep[] }>("/device/keep")).records,
    sendKeep: (send: KeepSend) => {
      const path = `/works/${encodeURIComponent(send.workId)}/keep`;
      if (send.kind === "off") return api<ServerKeep>(path, { method: "DELETE", body: JSON.stringify({ at: send.at }) });
      if (send.kind === "complete") return api<ServerKeep>(path, { method: "PUT", body: JSON.stringify({ completeAt: send.completeAt }) });
      return api<ServerKeep>(path, {
        method: "PUT",
        body: JSON.stringify(send.completeAt === null ? { at: send.at } : { at: send.at, completeAt: send.completeAt }),
      });
    },
    clearedAt: async () => {
      const value = (await db.preferences.get(CLEARED_KEY))?.value;
      return typeof value === "number" ? value : null;
    },
    setClearedAt: async (at) => {
      if (at === null) await db.preferences.delete(CLEARED_KEY);
      else await db.preferences.put({ key: CLEARED_KEY, value: at });
    },
    rolloutDone: async () => (await db.preferences.get(ROLLOUT_KEY))?.value === true,
    markRolloutDone: async () => {
      await db.preferences.put({ key: ROLLOUT_KEY, value: true });
    },
    saveTrack: (track, signal, onProgress) => downloadTrack(track as Track, signal, onProgress),
    saveEbook: keepEbook,
    saveMap: keepMap,
    saveText: keepText,
    // A kept EPUB file its prepared text replaced (#805): the file goes, the text and the place stay.
    dropEpub: async (ebookId) => {
      await removeEbookFromDevice(ebookId);
      await removeOfflineEbook(ebookId);
    },
    writeRecord: async (recordingId, workId, change) => {
      if (change.state === "off") return;
      await writeDeviceSaveRecord(recordingId, workId, change);
    },
    removeWork: (workId) => removeBookFiles(workId),
    remember: async (workId, saved) => {
      await db.transaction("rw", db.keep, async () => {
        const entry = await db.keep.get(workId);
        if (entry) await db.keep.put({ ...entry, recordings: saved.recordings, ebookIds: saved.ebookIds });
      });
    },
    online: () => navigator.onLine,
    claim: async (recordingId, save) => {
      const result = await claimRecording<SaveStop | null>(recordingId, save);
      return result.ran ? result.value : "busy";
    },
    running: activeSaves,
    onJob: (recordingId, job) => {
      for (const listener of jobListeners) listener(recordingId, job);
    },
    onChanged: () => {
      window.dispatchEvent(new Event("sonder:downloads-changed"));
      keepChanged();
    },
  });
  saver = created;
  saverAccount = account;
  const trigger = (reason: KeepTrigger) => void created.trigger(reason);
  const visible = () => {
    if (document.visibilityState === "visible") trigger("foreground");
  };
  const online = () => trigger("online");
  const library = () => trigger("library");
  // A choice of edition on this device (the Ebook page's tick) changes which EPUB a kept book needs (#551). A copy
  // written or removed fires the same event without a work and asks for nothing.
  const ebookChosen = (event: Event) => (event as CustomEvent<{ workId?: string }>).detail?.workId && trigger("library");
  // A closed or frozen tab interrupts its saves; they resume at the next run (here after a return, or in another tab).
  const closed = () => {
    for (const recordingId of activeSaves.keys()) created.pause(recordingId, "closed");
  };
  const shown = (event: PageTransitionEvent) => event.persisted && trigger("foreground");
  document.addEventListener("visibilitychange", visible);
  document.addEventListener("freeze", closed);
  document.addEventListener("resume", visible);
  window.addEventListener("online", online);
  window.addEventListener(LIBRARY_STORED_EVENT, library);
  window.addEventListener(EBOOK_DEVICE_EVENT, ebookChosen);
  window.addEventListener("pagehide", closed);
  window.addEventListener("pageshow", shown);
  unwire = () => {
    document.removeEventListener("visibilitychange", visible);
    document.removeEventListener("freeze", closed);
    document.removeEventListener("resume", visible);
    window.removeEventListener("online", online);
    window.removeEventListener(LIBRARY_STORED_EVENT, library);
    window.removeEventListener(EBOOK_DEVICE_EVENT, ebookChosen);
    window.removeEventListener("pagehide", closed);
    window.removeEventListener("pageshow", shown);
    channel?.close();
  };
  created.start();
  void dropReadingCaches();
  return created;
}

/**
 * The reader's own copies of the EPUBs it opened (its reading cache, #671) are read by nothing since the reader shows
 * the prepared text only (#806), and nothing writes them any more: each is removed from this device. A copy the user
 * kept is left to Keep, which removes it once its prepared text is complete (`dropEpub`).
 */
async function dropReadingCaches() {
  const copies = await listOfflineEbookCopies().catch(() => []);
  for (const copy of copies) if (!copy.kept) await removeOfflineEbook(copy.id).catch(() => {});
}

/**
 * What this device holds of the stored works' EPUBs, their prepared texts (#805) and maps, and this user's choices of
 * edition (#551).
 */
async function readingHeld(works: readonly LibraryWork[]) {
  const ebooks: HeldEbook[] = [];
  const epubIds = works.flatMap((work) => (work.ebooks ?? []).filter((ebook) => ebook.format === "epub").map((ebook) => ebook.id));
  const texts = epubIds.length ? await listKeptTexts(epubIds).catch(() => []) : [];
  const maps: Record<string, HeldMap | undefined> = {};
  const ebookChoices: Record<string, string | null> = {};
  for (const work of works) {
    ebookChoices[work.workId] = deviceEbookChoice(work.workId);
    for (const ebook of work.ebooks ?? []) {
      if (ebook.format !== "epub") continue;
      const stored = (await authDB.preferences.get(readerFileKey(ebook.id)).catch(() => undefined))?.value as ReaderFileRecord;
      // Only a copy the user chose to keep counts: the reader's own reading cache is not kept (#671).
      if (!isKeptReaderFile(stored) || !stored?.fingerprint) continue;
      const size = await ebookDeviceCopySize(ebook.id, { kept: true });
      if (size != null) ebooks.push({ id: ebook.id, fingerprint: stored.fingerprint, size });
    }
    for (const job of work.readingSync ?? []) {
      const key = readerMapKey(job.ebookId, job.recordingId);
      const stored = (await localDB.preferences.get(key).catch(() => undefined))?.value as HeldMap | undefined;
      if (stored) maps[key] = stored;
    }
  }
  return { ebooks, texts, maps, ebookChoices };
}

/** The SHA-256 of a file in hex, as the server fingerprints an EPUB (`server/reader.ts`); null where the page has none. */
export async function fingerprintFile(blob: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A refusal of the source (4xx other than a timeout or a rate limit): the save waits for Retry. A 401 is a sign-out. */
function refusal(message: string, status: number) {
  const refused = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return Object.assign(new Error(message), { refused, status, ...(refused ? { failure: status === 401 ? "signed-out" : "source" } : {}) });
}

/**
 * Keeps an EPUB on this device (#551): its details and place for the reader (`loadReader` stores them), then the
 * file, fetched, fingerprinted on the device with SHA-256 and stored by `saveEpubOffline` as a kept copy.
 */
export async function keepEbook(ebookId: string, signal: AbortSignal): Promise<void> {
  const book = await loadReader(ebookId);
  signal.throwIfAborted();
  const response = await fetch(`/api/ebooks/${encodeURIComponent(ebookId)}/file`, { signal });
  if (!response.ok) throw refusal("The EPUB could not be saved on this device.", response.status);
  const blob = await response.blob();
  signal.throwIfAborted();
  const fingerprint = (await fingerprintFile(blob)) ?? book.fingerprint;
  // A file that is not the one the server describes arrived damaged: saved again at the next run.
  if (book.fingerprint && fingerprint !== book.fingerprint) throw new Error("The EPUB arrived incomplete.");
  await saveEpubOffline({ id: ebookId, fingerprint }, blob);
}

/**
 * Keeps the reading sync map of a pair on this device (#551), by `warmMap`, against the kept EPUB's fingerprint, or
 * where no EPUB is kept (#806) the kept prepared text's, as `keptNeeds` matches it.
 */
export async function keepMap(ebookId: string, recordingId: string, signal: AbortSignal): Promise<void> {
  const fingerprint = async () =>
    ((await authDB.preferences.get(readerFileKey(ebookId)).catch(() => undefined))?.value as ReaderFileRecord)?.fingerprint ??
    ((await authDB.preferences.get(readerTextKey(ebookId)).catch(() => undefined))?.value as { fingerprint?: string } | undefined)?.fingerprint;
  const job = await warmMap(alignmentMapDeps(), { ebookId, recordingId, fingerprint, isCancelled: () => signal.aborted });
  signal.throwIfAborted();
  // warmMap answers null for any failure: a network failure here, tried again at the next run.
  if (!job) throw new TypeError("The reading sync could not be saved on this device.");
}

/** Fired by the library loader when a read of `GET /api/library` stored a new body. */
export const LIBRARY_STORED_EVENT = "sonder:library-works-stored";

export function stopKeepSaver(cause: StopCause = "closed") {
  saver?.stop(cause);
  unwire?.();
  unwire = null;
  saver = null;
  saverAccount = null;
}

/**
 * Asks the browser to keep this site's storage (`navigator.storage.persist()`). Only on a tap: the switch's, or the
 * Protected storage row's. Not waited on by the save: Firefox answers with a prompt that may stay unanswered.
 */
export function askPersist(): Promise<boolean> {
  return (navigator.storage?.persist?.() ?? Promise.resolve(false)).catch(() => false);
}

/** Stores a choice of Keep on this device now, pending until the server answers it. */
async function writeChoice(workId: string, on: boolean, now = Date.now()): Promise<void> {
  const { db } = accountDatabase();
  await db.transaction("rw", db.keep, async () => {
    const previous = await db.keep.get(workId);
    // Later than the choice it replaces, also when the clock went back.
    const at = Math.max(now, (previous?.at ?? 0) + 1);
    const entry: KeepEntry = { workId, on, at, completeAt: on ? previous?.completeAt ?? null : null, pending: true };
    await db.keep.put(entry);
  });
  keepChanged();
}

/**
 * The Keep switch's tap: stored at once, sent to the server and saved by the saver's run, which is asked for and
 * not waited on. Turning it on asks for persistent storage.
 */
export async function tapKeep(workId: string, on: boolean): Promise<void> {
  if (saver) return saver.tap(workId, on);
  if (on) void askPersist();
  await writeChoice(workId, on);
}

/** This account's Keep record of a work on this device, read again when it changes. */
export function useKeepRecord(workId: string): KeepEntry | null | undefined {
  const [record, setRecord] = useState<KeepEntry | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = () =>
      void localDB.keep
        .get(workId)
        .then((value) => live && setRecord(value ?? null))
        .catch(() => live && setRecord(null));
    read();
    window.addEventListener(KEEP_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(KEEP_EVENT, read);
    };
  }, [workId]);
  return record;
}

/**
 * The saves another tab of this account runs, as its records note them: shown with the same line and bar. A tab
 * that saves itself shows its own.
 */
export function savesInOtherTabs(records: readonly DeviceSaveRecord[]): Record<string, KeepJob> {
  if (saver?.isLeader) return {};
  const jobs: Record<string, KeepJob> = {};
  for (const record of records) if (record.state === "saving" && record.job && !activeSaves.has(record.recordingId)) jobs[record.recordingId] = record.job;
  return jobs;
}

/**
 * What a work needs on this device (#551): the chosen recording's tracks, the chosen EPUB and the pair's map, read
 * again when the device's files, its EPUB copies or its Keep records change.
 */
export function useKeptNeeds(work: LibraryWork | null, downloads: readonly Download[], parts: readonly DownloadPart[]): KeptNeeds | null {
  const [held, setHeld] = useState<{ workId: string; value: Awaited<ReturnType<typeof readingHeld>> } | null>(null);
  const workId = work?.workId ?? null;
  const shape = work ? JSON.stringify([work.ebooks.map((e) => e.id), work.readingSync.map((j) => [j.id, j.updatedAt])]) : "";
  useEffect(() => {
    if (!work) return;
    let live = true;
    const read = () => void readingHeld([work]).then((value) => live && setHeld({ workId: work.workId, value })).catch(() => {});
    read();
    window.addEventListener(KEEP_EVENT, read);
    window.addEventListener(EBOOK_DEVICE_EVENT, read);
    window.addEventListener("sonder:downloads-changed", read);
    return () => {
      live = false;
      window.removeEventListener(KEEP_EVENT, read);
      window.removeEventListener(EBOOK_DEVICE_EVENT, read);
      window.removeEventListener("sonder:downloads-changed", read);
    };
  }, [workId, shape]);
  if (!work || !held || held.workId !== work.workId) return null;
  return keptNeeds(keepRecording(work), downloads, parts, {
    work,
    deviceChoice: held.value.ebookChoices[work.workId] ?? null,
    ebooks: held.value.ebooks,
    texts: held.value.texts,
    maps: held.value.maps,
  });
}

/**
 * Pause of a kept book from any tab (#552): `pausedAt` on its Keep record, and its running save stops wherever it
 * runs. `saveId` is the recording (or `ebook:<id>` for a book with only an ebook).
 */
export async function pauseKeep(workId: string, saveId: string | null): Promise<void> {
  if (saver) return saver.pauseWork(workId, saveId);
}

/** Resume or Retry of a kept book from any tab: the pause goes and the tab that saves saves it again. */
export async function resumeKeep(workId: string): Promise<void> {
  if (saver) return saver.resumeWork(workId);
}

/** A kept work with what it needs on this device, for Activity's entries and the On device filter (#552). */
export type KeptWork = { workId: string; entry: KeepEntry; needs: KeptNeeds };

/**
 * Every work this account keeps on this device (Keep on, in the stored library) with what it needs, read again when
 * the Keep records, the EPUB copies or the device's files change.
 */
export function useKeptWorks(works: ReadonlyMap<string, LibraryWork>, downloads: readonly Download[], parts: readonly DownloadPart[]): KeptWork[] {
  const [state, setState] = useState<{ keep: KeepEntry[]; held: Awaited<ReturnType<typeof readingHeld>> } | null>(null);
  const shape = JSON.stringify([...works.values()].map((w) => [w.workId, w.ebooks?.map((e) => e.id), w.readingSync?.map((j) => [j.id, j.updatedAt])]));
  useEffect(() => {
    let live = true;
    const read = () =>
      void (async () => {
        const keep = await localDB.keep.toArray();
        const kept = keep.filter((entry) => entry.on).map((entry) => works.get(entry.workId)).filter((w): w is LibraryWork => !!w);
        const held = await readingHeld(kept);
        if (live) setState({ keep, held });
      })().catch(() => {});
    read();
    window.addEventListener(KEEP_EVENT, read);
    window.addEventListener(EBOOK_DEVICE_EVENT, read);
    window.addEventListener("sonder:downloads-changed", read);
    return () => {
      live = false;
      window.removeEventListener(KEEP_EVENT, read);
      window.removeEventListener(EBOOK_DEVICE_EVENT, read);
      window.removeEventListener("sonder:downloads-changed", read);
    };
  }, [shape]);
  if (!state) return [];
  const kept: KeptWork[] = [];
  for (const entry of state.keep) {
    const work = works.get(entry.workId);
    if (!entry.on || !work || !work.inLibrary) continue;
    const needs = keptNeeds(keepRecording(work), downloads, parts, {
      work,
      deviceChoice: state.held.ebookChoices[work.workId] ?? null,
      ebooks: state.held.ebooks,
      texts: state.held.texts,
      maps: state.held.maps,
    });
    kept.push({ workId: entry.workId, entry, needs });
  }
  return kept;
}

/**
 * Every file of a book this device holds (#553): its recordings' files and sections (earlier copies included), its
 * EPUB copies (kept or the reader's own) and its maps, read from the device database. `work` is the stored work when
 * the caller has it; otherwise it is read.
 */
export async function readDeviceBook(workId: string, work?: Pick<LibraryWork, "recordings" | "ebooks" | "chosenRecordingId"> | null): Promise<DeviceBook> {
  const stored = work ?? ((await localDB.works.get(workId).catch(() => undefined)) as LibraryWork | undefined) ?? null;
  const entry = await localDB.keep.get(workId).catch(() => undefined);
  const recordings = (stored?.recordings ?? []).map((r) => ({ recordingId: r.recordingId, narrator: r.narrator }));
  const chosen = stored ? keepRecording(stored as never)?.recordingId ?? null : null;
  // The work's EPUBs, and those the Keep record remembers (the stored work may have left with the library entry).
  const ebookIds = [...new Set([...(stored?.ebooks ?? []).map((e) => e.id), ...(entry?.ebookIds ?? [])])];
  const downloads = (await localDB.downloads.toArray()).map((row) => ({ trackId: row.trackId, recordingId: row.recordingId, size: row.size }));
  const parts = (await localDB.downloadParts.toArray()).map((row) => ({ trackId: row.trackId, recordingId: row.recordingId, loaded: row.loaded }));
  const records = await listDeviceSaveRecords().catch(() => [] as DeviceSaveRecord[]);
  const ebookCopies: { id: string; size: number }[] = [];
  for (const id of ebookIds) {
    // An edition's copy here is its EPUB file, its kept prepared text (#805), or both.
    const file = await ebookDeviceCopySize(id);
    const text = await keptTextSize(id).catch(() => null);
    if (file != null || text != null) ebookCopies.push({ id, size: (file ?? 0) + (text ?? 0) });
  }
  const maps: { key: string; size: number }[] = [];
  const keys = (await localDB.preferences.where("key").startsWith("reader-map:").primaryKeys().catch(() => [])) as string[];
  const held = new Set([...recordings.map((r) => r.recordingId), ...(entry?.recordings ?? []).map((r) => r.recordingId), ...records.filter((r) => r.workId === workId).map((r) => r.recordingId)]);
  for (const key of keys) {
    const [, ebookId, recordingId] = key.split(":");
    if (!ebookIds.includes(ebookId) && !held.has(recordingId)) continue;
    const value = (await localDB.preferences.get(key).catch(() => undefined))?.value;
    maps.push({ key, size: value ? JSON.stringify(value).length : 0 });
  }
  return deviceBook({ workId, recordings, chosenRecordingId: chosen, ebookIds, remembered: entry?.recordings, records, downloads, parts, ebookCopies, maps });
}

/** Removes the files `plan` names: the saves running stop first, wherever they run. */
async function removePlan(plan: Pick<DeviceBook, "recordingIds" | "ebookIds" | "saveIds" | "mapKeys">): Promise<void> {
  for (const id of plan.saveIds) {
    const running = activeSaves.get(id);
    if (running && saver) saver.pause(id, "off");
    else if (running) running.abort();
    else saver?.pause(id, "off");
  }
  // A save of this tab stops at its next step: wait for it (briefly), so it writes no section after the removal.
  for (let i = 0; i < 40 && plan.saveIds.some((id) => activeSaves.has(id)); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  for (const id of plan.recordingIds) await deleteDownloads(id);
  for (const id of plan.saveIds) await deleteDownloads(id);
  for (const id of plan.ebookIds) {
    await removeEbookFromDevice(id);
    await removeOfflineEbook(id);
    await removeKeptText(id).catch(() => {});
  }
  for (const key of plan.mapKeys) await localDB.preferences.delete(key).catch(() => {});
  window.dispatchEvent(new Event("sonder:downloads-changed"));
  keepChanged();
}

/** Removes every file of a book from this device (#553), without touching its Keep record. */
export async function removeBookFiles(workId: string, work?: Pick<LibraryWork, "recordings" | "ebooks" | "chosenRecordingId"> | null): Promise<void> {
  await removePlan(await readDeviceBook(workId, work));
}

/**
 * Off (#553, spec #548 "Off"): writes Keep off, then removes the book's recordings (complete and partial, earlier
 * copies included), its EPUB copies, its maps and its save records. The place, the bookmarks and the library entry
 * stay. Remove on Activity's This device is the same action.
 */
export async function keepOffAndRemove(workId: string, work?: Pick<LibraryWork, "recordings" | "ebooks" | "chosenRecordingId"> | null): Promise<void> {
  await tapKeep(workId, false);
  await removeBookFiles(workId, work);
}

/** Removes an earlier copy (#553): one recording's files, sections, save record and maps; the kept one stays. */
export async function removeEarlierCopy(workId: string, recordingId: string): Promise<void> {
  const plan = await readDeviceBook(workId);
  await removePlan({
    recordingIds: [recordingId],
    ebookIds: [],
    saveIds: [recordingId],
    mapKeys: plan.mapKeys.filter((key) => key.endsWith(`:${recordingId}`)),
  });
}

/** A book's files on this device, read again when the device's files, EPUB copies or Keep records change. */
export function useDeviceBook(work: LibraryWork | null): DeviceBook | null {
  const [book, setBook] = useState<{ workId: string; value: DeviceBook } | null>(null);
  const workId = work?.workId ?? null;
  const shape = work ? JSON.stringify([work.chosenRecordingId, work.recordings.map((r) => [r.recordingId, r.narrator]), work.ebooks.map((e) => e.id)]) : "";
  useEffect(() => {
    if (!work) return;
    let live = true;
    const read = () => void readDeviceBook(work.workId, work).then((value) => live && setBook({ workId: work.workId, value })).catch(() => {});
    read();
    window.addEventListener(KEEP_EVENT, read);
    window.addEventListener(EBOOK_DEVICE_EVENT, read);
    window.addEventListener("sonder:downloads-changed", read);
    return () => {
      live = false;
      window.removeEventListener(KEEP_EVENT, read);
      window.removeEventListener(EBOOK_DEVICE_EVENT, read);
      window.removeEventListener("sonder:downloads-changed", read);
    };
  }, [workId, shape]);
  return book && work && book.workId === work.workId ? book.value : null;
}

/**
 * When this account's device noticed that the browser cleared Sonder's files (#554), or null: This device's note
 * under Storage. Every tab follows it: the saving tab's changes reach the others over the saver's channel.
 */
export function useKeepClearedAt(): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void localDB.preferences
        .get(CLEARED_KEY)
        .then((row) => live && setAt(typeof row?.value === "number" ? row.value : null))
        .catch(() => {});
    read();
    window.addEventListener(KEEP_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(KEEP_EVENT, read);
    };
  }, []);
  return at;
}
