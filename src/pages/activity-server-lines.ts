// Activity › Server (#519, spec #513 "Server"; boards ActivityServer.dc.html, ActivityServerEmpty.dc.html,
// ActivityServerPaused.dc.html, DesktopActivityServer.dc.html): the line of each row, from the server's activity
// answer. Pure: no React, no fetch. The screen is activity-server.tsx.
//
// A page module: the server imports none of it.
import type { ActivityItem, ActivityProcess, ActivityResponse } from "../types";
import { QUEUE_OFF_LINE, WORKER_OFF_LINE } from "../status-lines";
import { processNeedsAttention } from "../activity-now";

const DOT = " · ";

/** A queue with nothing in it. */
export const NOTHING_RUNNING = "Nothing running";
/** A queue an environment setting holds: its switch cannot be used. */
export const QUEUE_LOCKED_LINE = "Paused by a server setting";
/** The torrent client while it can download. */
export const TORRENT_RUNNING_LINE = "Running";
/** Imports, which nothing reports yet. */
export const NOT_TRACKED_LINE = "Not tracked yet";

/** The queues, with the words their lines count in: what runs, what waits, what is paused, what failed. */
export type QueueId = "alignment" | "acquisitions" | "server-copies" | "series-acquisition" | "ebook-set" | "backups";
const QUEUE_WORDS: Record<Exclude<QueueId, "backups">, { running: string; queued: string }> = {
  alignment: { running: "preparing", queued: "waiting" },
  acquisitions: { running: "downloading", queued: "waiting" },
  "server-copies": { running: "copying", queued: "waiting" },
  "series-acquisition": { running: "searching", queued: "waiting" },
  "ebook-set": { running: "checking", queued: "waiting" },
};

const open = (items: ActivityItem[], processId: string) => items.filter((item) => item.processId === processId && item.state !== "done");

/** "1 preparing · 1 waiting": what is there now, in the queue's own words; empty when nothing is. */
function counted(process: ActivityProcess, items: ActivityItem[]): string {
  const mine = open(items, process.id);
  if (process.id === "backups") {
    // The schedule's own line: its last run and the next ("Last run 17 Nov 03:00 UTC: succeeded, 48.0 MB · Next run …").
    return process.reason ?? "";
  }
  const words = QUEUE_WORDS[process.id as keyof typeof QUEUE_WORDS] ?? { running: "running", queued: "waiting" };
  const count = (state: ActivityItem["state"]) => mine.filter((item) => item.state === state).length;
  return [
    count("running") ? `${count("running")} ${words.running}` : "",
    count("queued") ? `${count("queued")} ${words.queued}` : "",
    count("paused") ? `${count("paused")} paused` : "",
    count("failed") ? `${count("failed")} failed` : "",
  ].filter(Boolean).join(DOT);
}

/**
 * A queue's line: what is there in its own words, or "Nothing running"; a queue switched off reads "Paused" first,
 * and one an environment setting holds "Paused by a server setting".
 */
export function queueLine(process: ActivityProcess, items: ActivityItem[]): string {
  const what = counted(process, items);
  const held = process.lockedBy ? QUEUE_LOCKED_LINE : process.paused ? QUEUE_OFF_LINE : "";
  if (held) return [held, what].filter(Boolean).join(DOT);
  return what || NOTHING_RUNNING;
}

/**
 * A row lights the attention dot, and carries its mark, when its process is down (spec #513 "The attention dot"):
 * the rule of Now's builder (#521), so the mark and the dot cannot disagree.
 */
export const lightsDot = (process: ActivityProcess | undefined) => !!process && processNeedsAttention(process);

/** The torrent client's line: "Running", or the health message when it cannot download. */
export function torrentLine(process: ActivityProcess): string {
  return process.health === "ok" ? TORRENT_RUNNING_LINE : process.reason || "Not checked yet";
}

/** A MyAnonamouse torrent as `GET /api/mam/seeding` answers it (#911, `server/mam-routes.ts`). */
export type MamSeeding = {
  id: string;
  title: string;
  state: "seeding" | "downloading" | "stopped" | "missing";
  progress: number;
  secondsSeeding: number | null;
  ratio: number | null;
  seededEnough: boolean;
};

/** The least a MAM torrent seeds (the owner's rule, #911): 72 hours. */
export const MAM_SEED_HOURS = 72;

/** A seeding time: "40 min", "31 h", "3 d 4 h". */
export function seedingTime(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} d ${rest} h` : `${days} d`;
}

/**
 * A MAM torrent's line on Activity › Server (#911): "Seeding · 31 h of 72 h · Ratio 0.42" until it has seeded its 72
 * hours, then "Seeding · 3 d 4 h · Ratio 1.20"; "Downloading 45%"; "Stopped in the torrent client"; "Not in the torrent
 * client".
 */
export function mamSeedingLine(torrent: MamSeeding): string {
  const ratio = torrent.ratio === null ? null : `Ratio ${torrent.ratio.toFixed(2)}`;
  const seeded =
    torrent.secondsSeeding === null
      ? null
      : torrent.seededEnough
        ? seedingTime(torrent.secondsSeeding)
        : `${seedingTime(torrent.secondsSeeding)} of ${MAM_SEED_HOURS} h`;
  if (torrent.state === "missing") return "Not in the torrent client";
  if (torrent.state === "downloading") return [`Downloading ${Math.floor(torrent.progress * 100)}%`, ratio].filter(Boolean).join(DOT);
  if (torrent.state === "stopped") return ["Stopped in the torrent client", seeded && `Seeded ${seeded}`, ratio].filter(Boolean).join(DOT);
  return ["Seeding", seeded, ratio].filter(Boolean).join(DOT);
}

/** The device a worker runs on, as the boards write it. */
export function deviceName(device: string | null | undefined): string {
  if (!device) return "";
  const lower = device.toLowerCase();
  if (lower === "cuda" || lower === "gpu" || lower.startsWith("cuda:")) return "GPU";
  if (lower === "cpu") return "CPU";
  return device.toUpperCase();
}

/** The stage of a whole-book job as the first word of what a worker runs ("Encoding: Feral Gods"). */
const STAGE_WORDS: Record<string, string> = {
  queued: "Waiting",
  decoding: "Decoding",
  encoding: "Encoding",
  anchoring: "Anchoring",
  aligning: "Aligning",
  finishing: "Saving",
  done: "Saving",
};

/** What a worker runs now ("Encoding: Feral Gods"), from the reading syncs running on it; empty when nothing. */
export function workerNow(process: ActivityProcess, items: ActivityItem[]): string {
  const host = process.host;
  if (!host) return "";
  const running = items.filter((item) => item.kind === "alignment" && item.host === host.hostId && item.state === "running");
  if (running.length)
    return running
      .map((item) => {
        const stage = item.facts.kind === "alignment" ? item.facts.stage : null;
        return `${(stage && STAGE_WORDS[stage]) || "Preparing"}: ${item.title}`;
      })
      .join(DOT);
  return host.jobs.map((title) => `Preparing: ${title}`).join(DOT);
}

/** A time of today as "14:02", of another day as "16 Nov 14:02", in the device's time zone. */
export function clockTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.getDate()} ${date.toLocaleString("en-GB", { month: "short" })} ${time}`;
}

/**
 * A worker's line: "Online · GPU · Encoding: Feral Gods", "Online · CPU", "Offline since 14:02", "Not in use · CPU".
 * A worker both switched off and unreachable reads only "Not in use".
 */
export function workerLine(process: ActivityProcess, items: ActivityItem[], now = Date.now()): string {
  const host = process.host;
  if (!host) return process.reason ?? "";
  const device = deviceName(host.device);
  if (host.disabled) return host.online ? [WORKER_OFF_LINE, device].filter(Boolean).join(DOT) : WORKER_OFF_LINE;
  if (!host.online) return process.since !== null ? `Offline since ${clockTime(process.since, now)}` : "Offline";
  return ["Online", device, workerNow(process, items)].filter(Boolean).join(DOT);
}

/** The worker rows: one per worker host the server reports, in its order. */
export const workers = (activity: ActivityResponse) => activity.processes.filter((process) => process.host);

/** Prepare for all books: how many are ready. */
export const prepareValue = (ready: number) => `${ready} ready`;

/** Prepare for all books: what queuing did. */
export function prepareResult(queued: number): string {
  return queued ? `Queued reading sync for ${queued} ${queued === 1 ? "book" : "books"}` : "No new books needed reading sync";
}
