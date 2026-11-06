import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

test("eight legacy maps migrate without losing their data or retaining reviewed trust", () => {
  const dir = mkdtempSync(join(tmpdir(), "sonder-alignment-migration-"));
  try {
    const legacy = new Database(join(dir, "sonder.db"));
    legacy.exec("CREATE TABLE alignment_jobs(id TEXT PRIMARY KEY,ebook_id TEXT NOT NULL,recording_id TEXT NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL)");
    const insert = legacy.prepare("INSERT INTO alignment_jobs VALUES(?,?,?,?,?)");
    for (let i = 0; i < 8; i++) {
      const data = { id: `job-${i}`, ebookId: `ebook-${i}`, recordingId: `recording-${i}`,
        status: "ready", warning: "Reviewed sections are ready.", intervals: [{ paragraphId: "0:0", section: 0, trackId: "track", start: 1, end: 2, confidence: 1, verified: true }],
        unverifiedCount: 0 };
      insert.run(data.id, data.ebookId, data.recordingId, JSON.stringify(data), i);
    }
    legacy.close();
    const alignmentModule = new URL("../server/alignment.ts", import.meta.url).href;
    const dbModule = new URL("../server/db.ts", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      const { alignmentJob } = await import(${JSON.stringify(alignmentModule)});
      const { sqlite } = await import(${JSON.stringify(dbModule)});
      for (let i = 0; i < 8; i++) {
        const map = alignmentJob('job-' + i);
        assert.equal(map.engine, 'aeneas-1.7.3');
        assert.equal(map.intervals[0].start, 1);
        assert.equal(map.intervals[0].verified, undefined);
        assert.equal(map.unverifiedCount, undefined);
        assert.doesNotMatch(map.warning, /reviewed/i);
      }
      sqlite.close();
    `;
    // Startup checks must also be safe when run a second time.
    for (let run = 0; run < 2; run++) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        env: { ...process.env, DATA_DIR: dir, MEDIA_ROOT: join(dir, "media") }, encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stderr);
    }
    const migrated = new Database(join(dir, "sonder.db"));
    try {
      const rows = migrated.prepare("SELECT engine,outcome,stage_timings,data FROM alignment_jobs ORDER BY id").all() as { engine: string; outcome: string | null; stage_timings: string | null; data: string }[];
      assert.equal(rows.length, 8);
      for (const row of rows) {
        assert.equal(row.engine, "aeneas-1.7.3");
        assert.equal(row.outcome, null);
        assert.equal(row.stage_timings, null);
        assert.equal(JSON.parse(row.data).intervals[0].verified, true, "migration leaves existing data intact");
      }
    } finally { migrated.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
