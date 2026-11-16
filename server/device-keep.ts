/**
 * Keep on this device, recorded on the server for each device (#549, ADR 0021, decided in #465).
 *
 * Each browser gets a device id in the `sonder_device` cookie. Each account's choice per work and
 * device is a row of `user_settings`: `keep:<deviceId>:<workId>` holding `{ on, at, completeAt }`.
 * Off is a record too (a tombstone), so "turned off" and "never known" differ. When the device was
 * last seen by that account is `keepDevice:<deviceId>` holding `{ seenAt }`; the records of a
 * device not seen for 400 days are dropped on a later read. No table changes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sqlite } from "./db.ts";
import { currentUserId, getUserSetting, setUserSetting } from "./users.ts";
import { workVisibleTo } from "./work-library.ts";

export const DEVICE_COOKIE = "sonder_device";
const DAY = 86_400_000;
/** How long the cookie lives and how long a device's records outlast its last read. */
export const DEVICE_LIFETIME_DAYS = 400;
/** A device's last-seen mark is written at most once a day, so reads do not write every time. */
const SEEN_RESOLUTION = DAY;

const DEVICE_ID = /^[A-Za-z0-9_-]{22,64}$/;
const recordPrefix = (deviceId: string) => `keep:${deviceId}:`;
const recordKey = (deviceId: string, workId: string) => `${recordPrefix(deviceId)}${workId}`;
const seenKey = (deviceId: string) => `keepDevice:${deviceId}`;

export type KeepRecord = { on: boolean; at: number; completeAt: number | null };
export type KeepAnswer = KeepRecord & { workId: string };

/** The device id the request's cookie names, when it is one this server could have given. */
function cookieDevice(req: FastifyRequest): string | null {
  const value = req.cookies[DEVICE_COOKIE];
  return value && DEVICE_ID.test(value) ? value : null;
}

/** The request's device id, given anew when it has none; the cookie is renewed on every call. */
function device(req: FastifyRequest, reply: FastifyReply): string {
  const deviceId = cookieDevice(req) ?? randomBytes(16).toString("base64url");
  reply.setCookie(DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: DEVICE_LIFETIME_DAYS * 86_400,
  });
  return deviceId;
}

function parseRecord(value: string): KeepRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<KeepRecord>;
    if (typeof parsed.on !== "boolean" || typeof parsed.at !== "number") return null;
    return { on: parsed.on, at: parsed.at, completeAt: typeof parsed.completeAt === "number" ? parsed.completeAt : null };
  } catch (error) {
    // A row this module did not write is not a record; it is read as none, and the next write replaces it.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function readRecord(userId: number, deviceId: string, workId: string) {
  const value = getUserSetting(userId, recordKey(deviceId, workId));
  return value ? parseRecord(value) : null;
}

function writeRecord(userId: number, deviceId: string, workId: string, record: KeepRecord) {
  setUserSetting(userId, recordKey(deviceId, workId), JSON.stringify(record));
}

/** Marks the device as seen by the user now, unless it was marked less than a day ago. */
function markSeen(userId: number, deviceId: string, now: number) {
  const seenAt = seenAtOf(getUserSetting(userId, seenKey(deviceId)));
  if (seenAt !== null && now - seenAt < SEEN_RESOLUTION && seenAt <= now) return;
  setUserSetting(userId, seenKey(deviceId), JSON.stringify({ seenAt: now }));
}

function seenAtOf(value: string): number | null {
  if (!value) return null;
  try {
    const seenAt = (JSON.parse(value) as { seenAt?: unknown }).seenAt;
    return typeof seenAt === "number" ? seenAt : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Drops, for every account, the records and the mark of each device the account has not seen for
 * 400 days, and records left without any mark.
 */
export function pruneDevices(now = Date.now()) {
  const cutoff = now - DEVICE_LIFETIME_DAYS * DAY;
  const marks = sqlite
    .prepare("SELECT user_id AS userId,key,value FROM user_settings WHERE key LIKE 'keepDevice:%'")
    .all() as { userId: number; key: string; value: string }[];
  const remove = sqlite.prepare("DELETE FROM user_settings WHERE user_id=? AND (key=? OR substr(key,1,?)=?)");
  const orphans = sqlite.prepare(
    `DELETE FROM user_settings WHERE key LIKE 'keep:%' AND NOT EXISTS (
       SELECT 1 FROM user_settings m WHERE m.user_id=user_settings.user_id
       AND m.key='keepDevice:' || substr(user_settings.key,6,instr(substr(user_settings.key,6),':')-1))`,
  );
  sqlite.transaction(() => {
    for (const mark of marks) {
      const seenAt = seenAtOf(mark.value);
      if (seenAt !== null && seenAt >= cutoff) continue;
      const deviceId = mark.key.slice("keepDevice:".length);
      const prefix = recordPrefix(deviceId);
      remove.run(mark.userId, mark.key, prefix.length, prefix);
    }
    orphans.run();
  })();
}

/** The user's records on this device, by work. */
function deviceRecords(userId: number, deviceId: string): KeepAnswer[] {
  const prefix = recordPrefix(deviceId);
  const rows = sqlite
    .prepare("SELECT key,value FROM user_settings WHERE user_id=? AND substr(key,1,?)=? ORDER BY key")
    .all(userId, prefix.length, prefix) as { key: string; value: string }[];
  const records: KeepAnswer[] = [];
  for (const row of rows) {
    const record = parseRecord(row.value);
    if (record) records.push({ workId: row.key.slice(prefix.length), ...record });
  }
  return records;
}

/** Every device the user has a mark or a record for. */
function userDevices(userId: number): string[] {
  const rows = sqlite
    .prepare("SELECT key FROM user_settings WHERE user_id=? AND (key LIKE 'keepDevice:%' OR key LIKE 'keep:%')")
    .all(userId) as { key: string }[];
  const devices = new Set<string>();
  for (const { key } of rows) {
    if (key.startsWith("keepDevice:")) devices.add(key.slice("keepDevice:".length));
    else {
      const rest = key.slice("keep:".length);
      const end = rest.indexOf(":");
      if (end > 0) devices.add(rest.slice(0, end));
    }
  }
  return [...devices];
}

/**
 * Remove from library (#527) turns Keep off for the work on every device of the user, so each
 * device removes the files at its next check. A record already off and newer stays as it is.
 */
export function keepOffOnEveryDevice(userId: number, workId: string, now = Date.now()) {
  sqlite.transaction(() => {
    for (const deviceId of userDevices(userId)) {
      const stored = readRecord(userId, deviceId, workId);
      if (stored && !stored.on && stored.at >= now) continue;
      writeRecord(userId, deviceId, workId, { on: false, at: Math.max(now, stored?.at ?? 0), completeAt: null });
    }
  })();
}

/** A time the device names, never later than the server's now: a clock ahead must not freeze a record. */
const time = z.number().int().nonnegative().finite();
const keepBody = z.object({ at: time.optional(), completeAt: time.optional() }).passthrough();
const offBody = z.object({ at: time.optional() }).passthrough();

/**
 * Turning Keep on (`at` the time of the choice, now when absent), or a report that the device
 * completed its save (`completeAt` alone). A write older than the stored record is ignored and the
 * stored record answered.
 */
export function applyKeepOn(stored: KeepRecord | null, body: { at?: number; completeAt?: number }, now: number): KeepRecord {
  const completeAt = body.completeAt === undefined ? undefined : Math.min(body.completeAt, now);
  if (body.at === undefined && completeAt !== undefined) {
    // A completion report: it does not change the choice. Off stays off; an older report is ignored.
    if (!stored) return { on: true, at: completeAt, completeAt };
    if (!stored.on || (stored.completeAt !== null && completeAt < stored.completeAt)) return stored;
    return { ...stored, completeAt };
  }
  const at = Math.min(body.at ?? now, now);
  if (stored && at < stored.at) return stored;
  // Turning on again keeps what this device completed; an off record holds none (`applyKeepOff`).
  return { on: true, at, completeAt: completeAt ?? stored?.completeAt ?? null };
}

/** Turning Keep off at `at` (now when absent): the files go, so nothing is complete any more. */
export function applyKeepOff(stored: KeepRecord | null, body: { at?: number }, now: number): KeepRecord {
  const at = Math.min(body.at ?? now, now);
  if (stored && at < stored.at) return stored;
  return { on: false, at, completeAt: null };
}

export function registerDeviceKeep(app: FastifyInstance) {
  app.get("/api/device/keep", async (req, reply) => {
    const userId = currentUserId(req);
    const deviceId = device(req, reply);
    const now = Date.now();
    markSeen(userId, deviceId, now);
    pruneDevices(now);
    reply.header("Cache-Control", "private, no-store");
    return { records: deviceRecords(userId, deviceId) };
  });

  /** Applies one write to the request's device and answers the record as it is stored after it. */
  const write = async (req: FastifyRequest, reply: FastifyReply, apply: (stored: KeepRecord | null, now: number) => KeepRecord) => {
    const userId = currentUserId(req);
    const { workId } = req.params as { workId: string };
    if (!workVisibleTo(userId, workId)) return reply.code(404).send({ error: "This book could not be found." });
    const deviceId = device(req, reply);
    const now = Date.now();
    const record = sqlite.transaction(() => {
      markSeen(userId, deviceId, now);
      const stored = readRecord(userId, deviceId, workId);
      const next = apply(stored, now);
      if (next !== stored) writeRecord(userId, deviceId, workId, next);
      return next;
    })();
    return { workId, ...record } satisfies KeepAnswer;
  };
  app.put("/api/works/:workId/keep", async (req, reply) => {
    const body = keepBody.parse(req.body ?? {});
    return write(req, reply, (stored, now) => applyKeepOn(stored, body, now));
  });
  app.delete("/api/works/:workId/keep", async (req, reply) => {
    const body = offBody.parse(req.body ?? {});
    return write(req, reply, (stored, now) => applyKeepOff(stored, body, now));
  });
}
