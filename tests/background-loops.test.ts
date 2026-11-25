import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
const { sqlite } = await import("../server/db.ts");
// A stale check only the download queue's run at start would turn into an error.
sqlite.prepare("INSERT INTO acquisitions(id,hash,backend,title,author,cover,status,created_at,updated_at,magnet) VALUES('stale','h','local','Stale','A','','checking',?,?,'magnet:?xt=urn:btih:h')")
  .run(Date.now() - 600_000, Date.now() - 600_000);
const { stopServerDownloads } = await import("../server/downloads.ts");
const { resetStrandedSeriesAcquisitionClaims } = await import("../server/series-acquisition.ts");
const { alignmentSchedulerForTests } = await import("../server/alignment.ts");
const app = await createApp({ background: { manual: true } });
const runner = backgroundRunner(app);
after(() => rmSync(temp, { recursive: true, force: true }));

test("the app runs its thirteen loops in one runner (Hardcover sync went, #721 part d), with the intervals and immediate runs they always had", { timeout: 10_000 }, () => {
  assert.deepEqual(
    runner.processes().map(({ id, intervalMs, runAtStart, pausedBy }) => ({ id, intervalMs, runAtStart: !!runAtStart, pausedBy })),
    [
      { id: "alignment", intervalMs: 5_000, runAtStart: false, pausedBy: "alignment" },
      { id: "activity-sampler", intervalMs: 60_000, runAtStart: false, pausedBy: undefined },
      { id: "acquisitions", intervalMs: 10_000, runAtStart: true, pausedBy: "acquisitions" },
      { id: "server-copies", intervalMs: 10_000, runAtStart: true, pausedBy: "server-copies" },
      { id: "series-acquisition", intervalMs: 30_000, runAtStart: true, pausedBy: "series-acquisition" },
      // The ebook-set evaluation (#325) runs at start, so members left pending by a restart resume.
      { id: "ebook-set", intervalMs: 30_000, runAtStart: true, pausedBy: "ebook-set" },
      { id: "backups", intervalMs: 600_000, runAtStart: false, pausedBy: "backups" },
      // TorBox previews (#889) end at start and each minute: a restart forgets none, a closed tab ends one in 30 minutes.
      { id: "torbox-previews", intervalMs: 60_000, runAtStart: true, pausedBy: undefined },
      { id: "catalogue-refresh", intervalMs: 3_600_000, runAtStart: false, pausedBy: undefined },
      // The catalogue's covers for placeholders and series rows that have none (#900), at start so a restart fills them.
      { id: "catalogue-covers", intervalMs: 86_400_000, runAtStart: true, pausedBy: undefined },
      // Series on AudiobookDB (#721 part b): saved series read again (hourly, each once a day), and the Hardcover
      // series saved again after the reset, at start so a restart resumes it.
      { id: "series-refresh", intervalMs: 3_600_000, runAtStart: false, pausedBy: undefined },
      { id: "series-resave", intervalMs: 900_000, runAtStart: true, pausedBy: undefined },
      // Prepared text made ahead (#827): each minute the loop looks whether a sweep is due (after the start, then hourly).
      { id: "prepared-text", intervalMs: 60_000, runAtStart: false, pausedBy: undefined },
    ],
    "start order; the app stops them in reverse",
  );
  const stale = sqlite.prepare("SELECT status FROM acquisitions WHERE id='stale'").get() as { status: string };
  assert.equal(stale.status, "checking", "manual: the download queue did not run at start");
  const switches = runner.processes().flatMap(({ pausedBy }) => (pausedBy ? [pausedBy] : []));
  assert.deepEqual([...switches].sort(), [...PAUSABLE_PROCESSES].sort(), "every pause switch holds exactly one loop");
});

test("the runner holds each loop while its switch is on, and the series loop while its environment flag is set", { timeout: 10_000 }, async () => {
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
  for (const id of ["ebook-set", "series-acquisition", "activity-sampler"])
    assert.equal(await runner.tick(id), "ran", `${id}: resumed`);
});

test("the daily backup loop starts no backup while paused, makes one when resumed, and the Activity page shows it (#361)", { timeout: 20_000 }, async () => {
  const folder = join(temp, "db", "backups");
  setPaused("backups", true);
  try {
    assert.equal(await runner.tick("backups"), "held");
    assert.equal(existsSync(folder) && readdirSync(folder).length > 0, false, "pausing stops new runs");
  } finally {
    setPaused("backups", false);
  }
  assert.equal(await runner.tick("backups"), "ran");
  const made = readdirSync(folder);
  assert.equal(made.length, 1, made.join(", "));
  assert.match(made[0], /^daily-\d{4}-\d{2}-\d{2}\.db$/);
  const run = sqlite.prepare("SELECT status, error FROM backup_runs").get() as { status: string; error: string | null };
  assert.deepEqual(run, { status: "done", error: null }, "free space under the temporary folder must be at least 1 GiB");
  assert.equal(await runner.tick("backups"), "ran");
  assert.equal(readdirSync(folder).length, 1, "one backup a day");

  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": "203.0.113.190" }, payload: { password: "admin-password" } });
  const activity = (await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: login.cookies[0].value } })).json();
  const process = activity.processes.find((entry: { id: string }) => entry.id === "backups");
  assert.equal(process.notTracked, false);
  assert.match(process.reason, /^Last run \d+ \w{3} \d{2}:\d{2} UTC: succeeded, \d+\.\d MB · Next run \d+ \w{3} 03:00 UTC$/);
  const item = activity.items.find((entry: { id: string }) => entry.id === `backup:${made[0].slice(6, 16)}`);
  assert.equal(item?.state, "done");
});

test("the loops keep their start and close work, and closing the app releases this instance's alignment claims", { timeout: 10_000 }, async () => {
  const loop = (id: string) => runner.processes().find((process) => process.id === id);
  assert.equal(loop("series-acquisition")?.start, resetStrandedSeriesAcquisitionClaims, "series: free the claims a previous process left");
  assert.equal(loop("server-copies")?.stop, stopServerDownloads, "copies: abort the running copies on close");
  sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES('wl','Loop book','A','','',2000)").run();
  sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('edl','wl','','',0,'')").run();
  sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES('rl','edl')").run();
  sqlite.prepare("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('ebl','wl','epub',?)").run(join(temp, "none.epub"));
  sqlite.prepare("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at,claim_owner,claim_generation,claimed_at) VALUES('job-loop','ebl','rl','{}',?,?,'g1',?)")
    .run(Date.now(), alignmentSchedulerForTests().owner, Date.now());
  await app.close();
  const claim = sqlite.prepare("SELECT claim_owner FROM alignment_jobs WHERE id='job-loop'").get() as { claim_owner: string | null };
  assert.equal(claim.claim_owner, null, "the alignment loop's stop hook released the claim");
  assert.equal(await runner.tick("ebook-set"), "stopped", "no loop ticks after close");
});
