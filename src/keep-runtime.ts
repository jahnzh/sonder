/**
 * Keep on this device in the browser (#550): the saver of `keep-saver.ts` wired to the account's device database,
 * the API, Web Locks, a BroadcastChannel and today's `downloadInChunks`, and what the screens read of it.
 *
 * The server must not import this file: the production image copies only four files of `src/`.
 */
import { useEffect, useState } from "react";
import type { DeviceSaveRecord } from "./device-saves";
import type { KeepEntry, KeepSend, SaveStop, ServerKeep, StopCause } from "./keep";
import { KeepSaver, type KeepJob, type KeepTrigger, type LockManager, type SaverMessage } from "./keep-saver";
import { accountDatabase, api, downloadTrack, getDownloadedBlob, listDeviceSaveRecords, localDB, writeDeviceSaveRecord } from "./lib";
import type { Track } from "./types";

/** Fired when this account's Keep records on this device changed. */
export const KEEP_EVENT = "sonder:keep-changed";
const ROLLOUT_KEY = "keep-rollout";

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
      return {
        works: await db.works.toArray(),
        keep: await db.keep.toArray(),
        downloads,
        parts: await localDB.downloadParts.toArray(),
        records: await listDeviceSaveRecords().catch(() => [] as DeviceSaveRecord[]),
      };
    },
    writeChoice: (workId, on) => writeChoice(workId, on),
    persist: askPersist,
    storeKeep: async (records) => {
      await db.transaction("rw", db.keep, async () => {
        await db.keep.bulkPut(records);
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
    rolloutDone: async () => (await db.preferences.get(ROLLOUT_KEY))?.value === true,
    markRolloutDone: async () => {
      await db.preferences.put({ key: ROLLOUT_KEY, value: true });
    },
    saveTrack: (track, signal, onProgress) => downloadTrack(track as Track, signal, onProgress),
    writeRecord: async (recordingId, workId, change) => {
      if (change.state === "off") return;
      await writeDeviceSaveRecord(recordingId, workId, change);
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
  window.addEventListener("pagehide", closed);
  window.addEventListener("pageshow", shown);
  unwire = () => {
    document.removeEventListener("visibilitychange", visible);
    document.removeEventListener("freeze", closed);
    document.removeEventListener("resume", visible);
    window.removeEventListener("online", online);
    window.removeEventListener(LIBRARY_STORED_EVENT, library);
    window.removeEventListener("pagehide", closed);
    window.removeEventListener("pageshow", shown);
    channel?.close();
  };
  created.start();
  return created;
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
