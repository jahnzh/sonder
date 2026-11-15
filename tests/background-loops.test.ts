import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-loops-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.SONDER_SKIP_SERIES_ACQUISITION;
const { createApp } = await import("../server/app.ts");
const { backgroundRunner } = await import("../server/background-runner.ts");
const { setPaused, PAUSABLE_PROCESSES } = await import("../server/activity-pause.ts");
const app = await createApp({ background: { manual: true } });
const runner = backgroundRunner(app);
after(async () => {
  await app.close();
  rmSync(temp, { recursive: true, force: true });
});

test("the app runs its six loops in one runner, with the intervals and immediate runs they always had", () => {
  assert.deepEqual(
    runner.processes().map(({ id, intervalMs, runAtStart, pausedBy }) => ({ id, intervalMs, runAtStart: !!runAtStart, pausedBy })),
    [
      { id: "alignment", intervalMs: 5_000, runAtStart: false, pausedBy: "alignment" },
      { id: "activity-sampler", intervalMs: 60_000, runAtStart: false, pausedBy: undefined },
      { id: "acquisitions", intervalMs: 10_000, runAtStart: true, pausedBy: "acquisitions" },
      { id: "server-copies", intervalMs: 10_000, runAtStart: true, pausedBy: "server-copies" },
      { id: "series-acquisition", intervalMs: 30_000, runAtStart: true, pausedBy: "series-acquisition" },
      { id: "hardcover-sync", intervalMs: 60_000, runAtStart: true, pausedBy: "hardcover-sync" },
    ],
    "start order; the app stops them in reverse",
  );
  const switches = runner.processes().flatMap(({ pausedBy }) => (pausedBy ? [pausedBy] : []));
  assert.deepEqual([...switches].sort(), [...PAUSABLE_PROCESSES].sort(), "every pause switch holds exactly one loop");
});

test("the runner holds each loop while its switch is on, and the series loop while its environment flag is set", async () => {
  for (const id of PAUSABLE_PROCESSES) {
    setPaused(id, true);
    try {
      assert.equal(await runner.tick(id), "held", `${id}: paused`);
    } finally {
      setPaused(id, false);
    }
  }
  process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
  try {
    assert.equal(await runner.tick("series-acquisition"), "held", "disabled by the environment");
  } finally {
    delete process.env.SONDER_SKIP_SERIES_ACQUISITION;
  }
  for (const id of ["hardcover-sync", "series-acquisition", "activity-sampler"])
    assert.equal(await runner.tick(id), "ran", `${id}: resumed`);
});
