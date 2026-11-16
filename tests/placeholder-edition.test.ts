// The placeholder rule (issue #483): an audio edition is a placeholder when none of its
// recordings has a track. Runs on a bare in-memory database without any server module, as
// the media state derivation does.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { isPlaceholderEdition, placeholderEditionSql } from "../server/placeholder-edition.ts";

function library() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE audio_editions(id TEXT PRIMARY KEY,work_id TEXT NOT NULL);
    CREATE TABLE recordings(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL REFERENCES audio_editions(id));
    CREATE TABLE tracks(id TEXT PRIMARY KEY,recording_id TEXT NOT NULL REFERENCES recordings(id));
  `);
  const edition = (id: string, recordings: number[]) => {
    database.prepare("INSERT INTO audio_editions(id,work_id) VALUES(?,'w')").run(id);
    recordings.forEach((tracks, r) => {
      database.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,?)").run(`${id}-r${r}`, id);
      for (let t = 0; t < tracks; t++)
        database.prepare("INSERT INTO tracks(id,recording_id) VALUES(?,?)").run(`${id}-r${r}-t${t}`, `${id}-r${r}`);
    });
  };
  edition("hc-1", [0]); // the Hardcover import's placeholder: one recording, no track
  edition("no-recording", []);
  edition("empty-recordings", [0, 0]);
  edition("real", [3]);
  edition("second-recording", [0, 1]);
  edition("hc-2", [1]); // an hc- id with a track is real: the rule does not read the id
  return database;
}

const expected: Record<string, boolean> = {
  "hc-1": true,
  "no-recording": true,
  "empty-recordings": true,
  real: false,
  "second-recording": false,
  "hc-2": false,
};

test("an audio edition is a placeholder when none of its recordings has a track, whatever its id", () => {
  const database = library();
  for (const [id, placeholder] of Object.entries(expected))
    assert.equal(isPlaceholderEdition(database, id), placeholder, id);
  database.close();
});

test("the SQL condition names the same editions as the function", () => {
  const database = library();
  const rows = database
    .prepare(`SELECT e.id FROM audio_editions e WHERE ${placeholderEditionSql("e.id")} ORDER BY e.id`)
    .pluck()
    .all();
  assert.deepEqual(
    rows,
    Object.keys(expected).filter((id) => expected[id]).sort(),
  );
  database.close();
});

test("the rule follows tracks as they are written and removed", () => {
  const database = library();
  database.prepare("INSERT INTO tracks(id,recording_id) VALUES('late','hc-1-r0')").run();
  assert.equal(isPlaceholderEdition(database, "hc-1"), false);
  database.prepare("DELETE FROM tracks WHERE recording_id='real-r0'").run();
  assert.equal(isPlaceholderEdition(database, "real"), true);
  database.close();
});

test("the rule works on several database handles at once", () => {
  const one = library();
  const two = library();
  two.prepare("DELETE FROM tracks").run();
  assert.equal(isPlaceholderEdition(one, "real"), false);
  assert.equal(isPlaceholderEdition(two, "real"), true);
  assert.equal(isPlaceholderEdition(one, "real"), false);
  one.close();
  two.close();
});
