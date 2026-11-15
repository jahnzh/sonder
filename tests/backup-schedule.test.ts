import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_HOUR_UTC, DAILY_BACKUPS_KEPT, MIN_FREE_BYTES,
  STALE_CLAIM_MS, backupDue, backupPlan, backupRefusal, dailyBackupDay, dailyBackupName, expiredDailyBackups, isScheduleFileName,
  lastBackupDay, nextBackupAt, scheduledDay,
} from "../server/backup-schedule.ts";

const at = (iso: string) => Date.parse(iso);

test("the schedule's constants are the ones the issue states", () => {
  assert.equal(BACKUP_HOUR_UTC, 3);
  assert.equal(DAILY_BACKUPS_KEPT, 14);
  assert.equal(MIN_FREE_BYTES, 1024 ** 3);
  assert.equal(STALE_CLAIM_MS, 30 * 60_000);
});

test("the due decision comes from the recorded successful days only; a day later than the latest due one is ignored", () => {
  const now = at("2026-11-16T09:00:00.000Z");
  assert.equal(lastBackupDay([], now), null);
  assert.equal(lastBackupDay(["2026-11-14", "2026-11-15", "garbage"], now), "2026-11-15");
  assert.equal(lastBackupDay(["2026-11-15", "2099-01-01"], now), "2026-11-15", "a clock that ran ahead and came back");
  assert.equal(lastBackupDay(["2026-11-16"], at("2026-11-16T02:00:00.000Z")), null, "today's row before today's 03:00 was written ahead");
  assert.deepEqual(backupPlan(["2026-11-15", "2099-01-01"], now), { lastDay: "2026-11-15", due: true, nextAt: now });
  assert.deepEqual(backupPlan(["2026-11-16", "2099-01-01"], now), { lastDay: "2026-11-16", due: false, nextAt: at("2026-11-17T03:00:00.000Z") });
  assert.deepEqual(backupPlan([], now), { lastDay: null, due: true, nextAt: now });
});

test("retention looks only at the schedule's own name for a run's day", () => {
  assert.equal(isScheduleFileName("2026-11-16", "daily-2026-11-16.db"), true);
  for (const file of ["daily-2026-11-15.db", "../daily-2026-11-16.db", "x/daily-2026-11-16.db", "/tmp/daily-2026-11-16.db", "daily-2026-11-16.db/"])
    assert.equal(isScheduleFileName("2026-11-16", file), false, file);
  assert.equal(isScheduleFileName("../x", "daily-../x.db"), false);
});

test("a day's backup is due from 03:00 UTC, once a day", () => {
  assert.equal(scheduledDay(at("2026-11-16T02:59:59.999Z")), "2026-11-15", "before 03:00 the latest due day is yesterday");
  assert.equal(scheduledDay(at("2026-11-16T03:00:00.000Z")), "2026-11-16");
  assert.equal(scheduledDay(at("2026-11-16T23:59:00.000Z")), "2026-11-16");

  assert.equal(backupDue("2026-11-15", at("2026-11-16T02:59:59.999Z")), false, "yesterday's backup covers the hours before 03:00");
  assert.equal(backupDue("2026-11-15", at("2026-11-16T03:00:00.000Z")), true, "today's backup is due at 03:00");
  assert.equal(backupDue("2026-11-16", at("2026-11-16T03:00:00.000Z")), false, "one a day: today's is made");
  assert.equal(backupDue("2026-11-16", at("2026-11-16T23:59:00.000Z")), false);
  assert.equal(backupDue("2026-11-17", at("2026-11-16T12:00:00.000Z")), false, "a clock set back does not repeat a backup");
});

test("a server that was down at 03:00 still makes the day's backup, and a first start makes one at once", () => {
  assert.equal(backupDue("2026-11-15", at("2026-11-16T14:20:00.000Z")), true, "down from 02:00 to 14:20");
  assert.equal(backupDue("2026-11-01", at("2026-11-16T14:20:00.000Z")), true, "down for two weeks");
  assert.equal(backupDue(null, at("2026-11-16T01:00:00.000Z")), true, "never backed up");
  assert.equal(backupDue("garbage", at("2026-11-16T01:00:00.000Z")), true, "an unreadable day counts as none");
});

test("the next run is now when a backup is due, otherwise 03:00 UTC the next day", () => {
  const now = at("2026-11-16T14:20:00.000Z");
  assert.equal(nextBackupAt("2026-11-15", now), now);
  assert.equal(nextBackupAt(null, now), now);
  assert.equal(nextBackupAt("2026-11-16", now), at("2026-11-17T03:00:00.000Z"));
  assert.equal(nextBackupAt("2026-11-15", at("2026-11-16T01:00:00.000Z")), at("2026-11-16T03:00:00.000Z"));
});

test("only daily-<date>.db names are daily backups", () => {
  assert.equal(dailyBackupName("2026-11-16"), "daily-2026-11-16.db");
  assert.equal(dailyBackupDay("daily-2026-11-16.db"), "2026-11-16");
  for (const name of [
    "before-8338c7b-1763000000.db", "before-daily-2026-11-16.db", "daily-2026-11-16.db-wal", "daily-2026-11-16.db.bak",
    "daily-2026-11-16", "Daily-2026-11-16.db", "daily-2026-1-16.db", ".daily-2026-11-16.db.backup-1-ab.tmp", "daily-latest.db", "x-daily-2026-11-16.db",
  ])
    assert.equal(dailyBackupDay(name), null, name);
});

test("retention keeps the newest 14 daily backups and returns nothing else", () => {
  const days = Array.from({ length: 20 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
  const daily = days.map(dailyBackupName);
  const others = ["before-abc-1.db", "before-def-2.db", "notes.txt", "daily-2026-10-01.db-wal", "daily-2026-10-02.db.bak"];
  const names = [...others, ...[...daily].reverse(), "daily-2026-09-01.db"];
  const made = new Set(daily);
  const expired = expiredDailyBackups(names, made);
  assert.deepEqual(expired, daily.slice(0, 6).reverse(), "the six oldest of twenty go");
  assert.equal(expiredDailyBackups(names, made, 14).length, 6);
  assert.ok(!expired.includes("daily-2026-09-01.db"), "a daily name the schedule did not record is never removed");
  for (const name of others) assert.ok(!expired.includes(name), name);
  assert.deepEqual(expiredDailyBackups(daily.slice(0, 14), made), [], "fourteen are all kept");
  assert.deepEqual(expiredDailyBackups(daily, made, 0), daily.slice(0, 19).reverse(), "a keep below one still keeps the newest");
});

test("a run is refused when the media drive check fails for the backup folder or free space is below the limit", () => {
  assert.equal(backupRefusal({ mountProblem: null, freeBytes: MIN_FREE_BYTES }), null);
  assert.match(
    backupRefusal({ mountProblem: null, freeBytes: MIN_FREE_BYTES - 1 }) ?? "",
    /^Backup refused: only 1074 MB free where backups are stored; a backup needs at least 1074 MB free\.$/,
  );
  assert.match(backupRefusal({ mountProblem: null, freeBytes: 20e6 }) ?? "", /only 20 MB free/);
  const drive = backupRefusal({ mountProblem: "The media drive is not mounted at /mnt/x.", freeBytes: 0 });
  assert.equal(drive, "Backup refused: the backup folder is on the media drive, and the drive check failed. The media drive is not mounted at /mnt/x.");
});
