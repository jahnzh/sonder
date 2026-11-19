// The lines of the Server pages of Settings (#580): the drive's sizes and its bar, Hardcover's Sync row, an account
// request's age and the line after Approve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedLine, driveSize, freeSpace, requestAge, usedLine, usedShare } from "../src/settings-server.ts";

const drive = (usedBytes: number | null, totalBytes: number | null, connected = true) => ({ connected, usedBytes, totalBytes });

test("Used: the share in one unit when both share it, then the free space, as the board writes it", () => {
  assert.equal(usedLine(drive(2.9e12, 4e12)), "2.9 of 4 TB · 1.1 TB free");
  assert.equal(usedLine(drive(640e9, 4e12)), "640 GB of 4 TB · 3.4 TB free");
  assert.equal(usedLine(drive(12e9, 500e9)), "12 of 500 GB · 488 GB free");
  assert.equal(usedLine(drive(null, null)), null);
  assert.equal(usedLine(drive(1e12, 4e12, false)), null);
  assert.equal(freeSpace(drive(3e12, 4e12)), "1 TB free");
  assert.equal(freeSpace(drive(5e12, 4e12)), "0 KB free");
  assert.deepEqual(driveSize(1.1e12), { figure: "1.1", unit: "TB" });
  assert.deepEqual(driveSize(999e9), { figure: "999", unit: "GB" });
});

test("the bar: the share used, held between 0 and 1, none without sizes or a drive", () => {
  assert.equal(usedShare(drive(1e12, 4e12)), 0.25);
  assert.equal(usedShare(drive(5e12, 4e12)), 1);
  assert.equal(usedShare(drive(null, 4e12)), null);
  assert.equal(usedShare(drive(1e12, 0)), null);
  assert.equal(usedShare(drive(1e12, 4e12, false)), null);
});

test("an account request's age and the line after Approve", () => {
  const now = Date.UTC(2026, 10, 18, 12);
  assert.equal(requestAge(now - 20_000, now), "just now");
  assert.equal(requestAge(now - 5 * 60000, now), "5 minutes ago");
  assert.equal(requestAge(now - 2 * 3600_000, now), "2 hours ago");
  assert.equal(requestAge(now - 3 * 86400_000, now), "3 days ago");
  assert.equal(approvedLine("bradley", true), "Approved bradley. The invite email was sent.");
  assert.equal(approvedLine("bradley", false), "Approved bradley. The invite email was not sent.");
});
