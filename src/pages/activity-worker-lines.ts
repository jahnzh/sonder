// The worker's page (#520, spec #513 "The worker's page"; boards Worker.dc.html, WorkerNotInUse.dc.html and the right
// half of DesktopActivityServer.dc.html): the value of each row, from the server's activity answer. Pure: no React, no
// fetch. The screen is activity-worker.tsx; the words a worker's row on Server uses are in activity-server-lines.ts.
//
// A page module: the server imports none of it.
import type { ActivityHostRestart, ActivityItem, ActivityProcess, ActivityResponse } from "../types";
import { WORKER_OFF_LINE } from "../status-lines";
import { NOTHING_RUNNING, clockTime, deviceName, workerNow } from "./activity-server-lines";

/** The caption under the worker's id. */
export const WORKER_CAPTION = "Reading sync worker";
/** What a value reads when the worker reports none (its code version, its device while it cannot be read). */
export const UNKNOWN_VALUE = "unknown";
/** The refusals a forced restart may override: the worker runs work, or its status cannot be read. */
export const FORCEABLE_REFUSALS: readonly string[] = ["host_busy", "host_unreadable"];

/** The worker the address names, among the workers the server reports; undefined for an id it does not know. */
export function findWorker(activity: ActivityResponse, hostId: string): ActivityProcess | undefined {
  return activity.processes.find((process) => process.host?.hostId === hostId);
}

/** Status: "Online", "Offline since 14:02" (or "Offline" when the server does not know since when), "Not in use". */
export function workerStatus(process: ActivityProcess, now = Date.now()): string {
  const host = process.host;
  if (!host) return "";
  // A worker both switched off and unreachable reads only "Not in use", as its row on Server does.
  if (host.disabled) return WORKER_OFF_LINE;
  if (!host.online) return process.since !== null ? `Offline since ${clockTime(process.since, now)}` : "Offline";
  return "Online";
}

/** Device: "GPU", "CPU", or unknown while the worker cannot be read. */
export function workerDevice(process: ActivityProcess): string {
  return deviceName(process.host?.device) || UNKNOWN_VALUE;
}

/** Now: what the worker runs ("Encoding: Feral Gods"), or "Nothing running". An offline worker runs nothing Sonder sees. */
export function workerNowValue(process: ActivityProcess, items: ActivityItem[]): string {
  if (!process.host?.online) return NOTHING_RUNNING;
  return workerNow(process, items) || NOTHING_RUNNING;
}

/** Code version: the revision the worker reports, or unknown when it reports none. */
export function workerRevision(process: ActivityProcess): string {
  return process.host?.revision || UNKNOWN_VALUE;
}

/** When the last restart was: "today 09:12", "yesterday 18:40", "16 Nov 14:02", in the device's time zone. */
export function restartWhen(at: number, now = Date.now()): string {
  const day = new Date(at).toDateString();
  if (day === new Date(now).toDateString()) return `today ${clockTime(at, now)}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.toDateString()) return `yesterday ${clockTime(at, at)}`;
  return clockTime(at, now);
}

/** The reason of a failed restart as the server kept it, without its full stop, so it reads after "·". */
const reasonOf = (message: string) => message.trim().replace(/\.$/, "") || "failed";

/** Restart's line: "Last: today 09:12 · ready again", or why it failed; empty when the page never restarted it. */
export function restartLine(last: ActivityHostRestart | null, now = Date.now()): string {
  if (!last) return "";
  return `Last: ${restartWhen(last.at, now)} · ${last.ok ? "ready again" : reasonOf(last.message)}`;
}
