// One library with every case the read by work (#485) has to tell apart, written as rows so the
// `GET /api/books` pin and the library-by-work route tests read the same database. Fixed
// timestamps, so a response for it is the same on every run.
//
// The owner (user 1, the administrator) and a second user, "sam", who is not one.
// Works:
// - w-only: only a placeholder (hc-101), in the owner's library, with a stored media state.
// - w-beside: a placeholder (hc-102) beside a real edition (ed-beside); both in the owner's library.
// - w-two: two real editions (ed-two-a, ed-two-b), both in the owner's library; the owner's newest
//   place is in rec-two-b. Sam has ed-two-a and a newer place in it. Linked to Hardcover.
// - w-unplayed: two real editions, no place; ed-unplayed-b was added first.
// - w-removed: ed-removed-keep (with a fault and a copy to the server in progress) and
//   ed-removed-gone, which `removeRecording` removes through the route.
// - w-outside: a real edition in nobody's library.
// - w-sam: only a placeholder (hc-103), in Sam's library only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Sqlite = import("better-sqlite3").Database;

export const T0 = Date.UTC(2026, 0, 1);
export const DAY = 86_400_000;
export const OWNER = 1;
export const SAM = 2;
export const OWNER_TOKEN = "owner-session-token";
export const SAM_TOKEN = "sam-session-token";
export const PLACEHOLDER_IDS = ["hc-101", "hc-102", "hc-103"];

/** Rows written before the app starts, so its demo seed is skipped (it only seeds an empty database). */
export function writeLibraryFixture(sqlite: Sqlite, mediaRoot: string, hashToken: (token: string) => string) {
  const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
  mkdirSync(join(mediaRoot, "fixture"), { recursive: true });
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(?,'admin',NULL,'admin',?)", OWNER, T0);
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(?,'sam',NULL,'user',?)", SAM, T0);
  run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(OWNER_TOKEN), Date.now() + DAY, OWNER);
  run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(SAM_TOKEN), Date.now() + DAY, SAM);

  const work = (id: string, title: string, year = 2001) =>
    run(
      "INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)",
      id,
      title,
      `Author of ${title}`,
      `About ${title}.`,
      "Fiction",
      year,
    );
  const edition = (id: string, workId: string, cover: string, narrator: string, language: string | null = "en") =>
    run(
      "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,?,?,?,?)",
      id,
      workId,
      cover,
      narrator,
      language,
      `Release ${id}`,
      4.2,
      "Test source",
    );
  const recording = (id: string, editionId: string) => run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", id, editionId);
  /** A local track whose file exists (on the server) or a remote one (not on the server). */
  const track = (id: string, recordingId: string, index: number, local: boolean, duration = 600) => {
    const source = local ? join(mediaRoot, "fixture", `${id}.mp3`) : `https://audio.example/${id}.mp3`;
    if (local) writeFileSync(source, "audio");
    run(
      "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,?,?,?,?,?,?)",
      id,
      recordingId,
      `Part ${index + 1}`,
      index,
      duration,
      source,
      local ? "local" : "remote",
      JSON.stringify([{ title: `Chapter ${index + 1}`, start: 0, end: duration }]),
    );
  };
  const shelf = (userId: number, editionId: string, addedAt: number, status = "unread") =>
    run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,?,?)", userId, editionId, status, addedAt);
  const place = (userId: number, recordingId: string, trackId: string, position: number, updatedAt: number) =>
    run(
      "INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(?,?,?,?,?,?)",
      userId,
      recordingId,
      trackId,
      position,
      600,
      updatedAt,
    );

  work("w-only", "Only a Placeholder");
  edition("hc-101", "w-only", "https://assets.hardcover.app/only.jpg", "Audio not added", null);
  recording("recording-hc-101", "hc-101");
  shelf(OWNER, "hc-101", T0 + 1 * DAY);
  run(
    "INSERT INTO work_media_states(user_id,work_id,state,hold_reason,acquisition_id,updated_at) VALUES(?,?,'missing','unreleased',NULL,?)",
    OWNER,
    "w-only",
    T0 + 1 * DAY,
  );

  work("w-beside", "Placeholder Beside Audio");
  edition("hc-102", "w-beside", "https://assets.hardcover.app/beside.jpg", "Audio not added", null);
  recording("recording-hc-102", "hc-102");
  shelf(OWNER, "hc-102", T0 + 2 * DAY);
  edition("ed-beside", "w-beside", "/covers/beside.jpg", "Beside Narrator");
  recording("rec-beside", "ed-beside");
  track("t-beside-0", "rec-beside", 0, true);
  shelf(OWNER, "ed-beside", T0 + 3 * DAY);

  work("w-two", "Two Recordings", 1969);
  edition("ed-two-a", "w-two", "/covers/two-a.jpg", "Narrator A");
  recording("rec-two-a", "ed-two-a");
  track("t-two-a-0", "rec-two-a", 0, true);
  track("t-two-a-1", "rec-two-a", 1, false, 900);
  shelf(OWNER, "ed-two-a", T0 + 4 * DAY);
  edition("ed-two-b", "w-two", "/covers/two-b.jpg", "Narrator B", "de");
  recording("rec-two-b", "ed-two-b");
  track("t-two-b-0", "rec-two-b", 0, false);
  shelf(OWNER, "ed-two-b", T0 + 5 * DAY, "listening");
  place(OWNER, "rec-two-a", "t-two-a-0", 120, T0 + 10 * DAY);
  place(OWNER, "rec-two-b", "t-two-b-0", 60, T0 + 11 * DAY);
  shelf(SAM, "ed-two-a", T0 + 6 * DAY);
  place(SAM, "rec-two-a", "t-two-a-1", 300, T0 + 20 * DAY);
  run(
    "INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES(?,?,?,?)",
    "w-two",
    9001,
    "two-recordings",
    JSON.stringify([{ id: 77, name: "Pair Saga", position: 1 }]),
  );

  work("w-unplayed", "Never Played");
  edition("ed-unplayed-a", "w-unplayed", "/covers/unplayed-a.jpg", "Narrator C");
  recording("rec-unplayed-a", "ed-unplayed-a");
  track("t-unplayed-a-0", "rec-unplayed-a", 0, true);
  shelf(OWNER, "ed-unplayed-a", T0 + 8 * DAY);
  edition("ed-unplayed-b", "w-unplayed", "/covers/unplayed-b.jpg", "Narrator D");
  recording("rec-unplayed-b", "ed-unplayed-b");
  track("t-unplayed-b-0", "rec-unplayed-b", 0, true);
  shelf(OWNER, "ed-unplayed-b", T0 + 7 * DAY);

  work("w-removed", "One Removed");
  edition("ed-removed-keep", "w-removed", "/covers/removed-keep.jpg", "Kept Narrator");
  recording("rec-removed-keep", "ed-removed-keep");
  track("t-removed-keep-0", "rec-removed-keep", 0, false);
  shelf(OWNER, "ed-removed-keep", T0 + 9 * DAY);
  run(
    "INSERT INTO media_faults(recording_id,scope,reason,note,updated_at) VALUES(?,?,?,?,?)",
    "rec-removed-keep",
    "original",
    "bad-audio",
    "Crackles in part 1",
    T0 + 9 * DAY,
  );
  run(
    "INSERT INTO server_downloads(recording_id,book_id,status,progress,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "rec-removed-keep",
    "ed-removed-keep",
    "downloading",
    0.4,
    null,
    T0 + 9 * DAY,
    T0 + 9 * DAY,
  );
  edition("ed-removed-gone", "w-removed", "/covers/removed-gone.jpg", "Gone Narrator");
  recording("rec-removed-gone", "ed-removed-gone");
  track("t-removed-gone-0", "rec-removed-gone", 0, true);
  shelf(OWNER, "ed-removed-gone", T0 + 9 * DAY);

  work("w-outside", "Outside the Library");
  edition("ed-outside", "w-outside", "/covers/outside.jpg", "Outside Narrator");
  recording("rec-outside", "ed-outside");
  track("t-outside-0", "rec-outside", 0, false);

  work("w-sam", "Sam's Placeholder");
  edition("hc-103", "w-sam", "https://assets.hardcover.app/sam.jpg", "Audio not added", null);
  recording("recording-hc-103", "hc-103");
  shelf(SAM, "hc-103", T0 + 12 * DAY);
}

type Inject = (options: { method?: "GET" | "DELETE"; url: string; cookies: Record<string, string> }) => Promise<{
  statusCode: number;
  body: string;
}>;

/** Removes ed-removed-gone from the owner's library the way the app does. */
export async function removeRecording(inject: Inject) {
  const removed = await inject({ method: "DELETE", url: "/api/library/ed-removed-gone", cookies: { sonder_session: OWNER_TOKEN } });
  if (removed.statusCode !== 200) throw new Error(`Removing ed-removed-gone failed: ${removed.body}`);
}
