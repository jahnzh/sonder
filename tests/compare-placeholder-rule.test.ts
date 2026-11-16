// scripts/compare-placeholder-rule.mjs (issue #483): on a database file, names the editions
// the old `hc-` prefix and the placeholder rule name, read-only, and exits 1 when they differ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-compare-placeholder-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";

// The server's schema, written once; the module's handle is closed before the script runs.
const { sqlite } = await import("../server/db.ts");
sqlite.close();
const file = join(process.env.DATA_DIR, "sonder.db");
const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/compare-placeholder-rule.mjs");

function write(change: (database: Database.Database) => void) {
  const database = new Database(file);
  change(database);
  database.close();
}

function edition(database: Database.Database, id: string, tracks: number) {
  database
    .prepare("INSERT OR IGNORE INTO works(id,title,author,description,genre,year) VALUES('w','T','A','','G',2020)")
    .run();
  database
    .prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES(?,'w','','N',0,'Test')")
    .run(id);
  database.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,?)").run(`rec-${id}`, id);
  for (let index = 0; index < tracks; index++)
    database
      .prepare(
        "INSERT INTO tracks(id,recording_id,title,track_index,source,source_type) VALUES(?,?,'C',?,'/dev/null','local')",
      )
      .run(`${id}-${index}`, `rec-${id}`, index);
}

const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const digest = () => createHash("sha256").update(readFileSync(file)).digest("hex");

test("when both rules name the same editions it lists them and exits 0, changing nothing", () => {
  write((database) => {
    edition(database, "hc-1", 0);
    edition(database, "hc-2", 0);
    edition(database, "real-1", 2);
  });
  const before = digest();
  const result = run(file);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(
    result.stdout,
    [
      "audio editions: 3",
      "old rule (id starts with hc-): 2",
      "  hc-1",
      "  hc-2",
      "new rule (no recording has a track): 2",
      "  hc-1",
      "  hc-2",
      "same: both rules name the same editions",
      "",
    ].join("\n"),
  );
  assert.equal(digest(), before, "the database file is unchanged");
});

test("when the rules differ it names the editions only one rule names and exits 1", () => {
  write((database) => {
    edition(database, "empty-1", 0);
    edition(database, "hc-3", 1);
  });
  const result = run(file);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /^differ: only old rule: hc-3$/m);
  assert.match(result.stdout, /^differ: only new rule: empty-1$/m);
});

test("it refuses a missing file and wrong arguments", () => {
  assert.equal(run(join(temp, "missing.db")).status, 2);
  assert.equal(run().status, 2);
  assert.equal(run("--help").status, 0);
});
