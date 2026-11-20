import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NoSuitableRecording } from "../scripts/live-check-recording.mjs";
import * as play from "../scripts/live-check-playback.mjs";
import { playbackTimeline } from "../src/chapters.ts";

// The fields of GET /api/books the selection reads (tests/live-check-recording.test.mjs has the full captured shape).
function book(n, { tracks = [{ duration: 640.584 }], progress, inLibrary = true } = {}) {
  const recordingId = `recording-${n}`;
  const built = tracks.map((t, index) => ({ chapters: t.chapters ?? [], id: `track-${n}-${index}`, recordingId, title: `file ${index + 1}`, index, duration: t.duration }));
  return {
    id: n,
    workId: `work-${n}`,
    recordingId,
    title: `Book ${n}`,
    tracks: built,
    duration: built.reduce((sum, t) => sum + t.duration, 0),
    inLibrary,
    ...(progress ? { progress: { recordingId, trackId: built[progress.track ?? 0].id, position: progress.position, updatedAt: progress.updatedAt ?? 1794748752519 } } : {}),
  };
}
const answer = (body, status = 200) => ({ status, text: typeof body === "string" ? body : JSON.stringify(body) });

test("playback check: the finished book does not qualify; the most recently listened qualifying book is picked", () => {
  const finished = book("finished", { progress: { position: 640.584, updatedAt: 900 } });
  const older = book("older", { progress: { position: 42, updatedAt: 100 } });
  const newer = book("newer", { progress: { position: 42, updatedAt: 500 } });
  const outside = book("outside", { progress: { position: 42, updatedAt: 999 }, inLibrary: false });
  const books = [finished, older, newer, outside];
  assert.equal(play.pickPlaybackRecording({ books }).recordingId, newer.recordingId);
  const named = play.pickPlaybackRecording({ books }, { preferred: finished.recordingId });
  assert.equal(named.recordingId, newer.recordingId);
  assert.deepEqual(named.preferred, { recordingId: finished.recordingId, reason: "the saved position is 0 s before the end of the book (needs more than 300 s)" });
  assert.equal(play.pickPlaybackRecording({ books }, { preferred: older.recordingId }).recordingId, older.recordingId);
  const none = play.pickPlaybackRecording({ books: [finished, outside] });
  assert.equal(none.recordingId, undefined);
  assert.equal(none.reason, "1 recording(s) in the library, none qualifies: recording-finished: the saved position is 0 s before the end of the book (needs more than 300 s)");
});

test("playback check: the chapter at the saved position must last at least 120 s for the slider drags", () => {
  const chapters = [{ title: "One", start: 0 }, { title: "Short", start: 1000, end: 1100 }, { title: "Long", start: 1100 }];
  const at = (position) => play.pickPlaybackRecording({ books: [book("chapters", { tracks: [{ duration: 4000, chapters }], progress: { position } })] });
  assert.equal(play.PLAYBACK_MIN_CHAPTER_SECONDS, 120);
  assert.match(at(1050).reason, /the slider at the saved position shows "Short", which lasts 100 s \(needs at least 120 s\)/);
  assert.equal(at(1200).recordingId, "recording-chapters");
  assert.equal(at(50).recordingId, "recording-chapters");
});

// Review round 1, HIGH: the slider's timeline treats an intro or a gap between chapters as its own timeline.
test("the reviewer's intro: saved at 0, first chapter 10-500 on a 1000 s file; the slider shows the 10 s introduction, so it does not qualify", () => {
  const intro = book("intro", { tracks: [{ duration: 1000, chapters: [{ title: "Chapter 1", start: 10, end: 500 }, { title: "Chapter 2", start: 500 }] }] });
  const result = play.playbackSequence(intro);
  assert.match(result.reason, /the slider at the saved position shows "Introduction", which lasts 10 s \(needs at least 120 s\)/);
  assert.equal(play.pickPlaybackRecording({ books: [intro] }).recordingId, undefined);
  // The same file saved inside chapter 1 qualifies, with the chapter as the timeline.
  const inside = book("inside", { tracks: [{ duration: 1000, chapters: [{ title: "Chapter 1", start: 10, end: 500 }, { title: "Chapter 2", start: 500 }] }], progress: { position: 42 } });
  assert.deepEqual(play.playbackSequence(inside).timeline, { scope: "chapter", title: "Chapter 1", trackId: "track-inside-0", start: 10, duration: 490, position: 32 });
});

test("a gap between chapters is its own timeline too, and a saved position near the end of its timeline does not qualify", () => {
  const chapters = [{ title: "A", start: 0, end: 400 }, { title: "B", start: 450, end: 2000 }];
  const gap = book("gap", { tracks: [{ duration: 3000, chapters }], progress: { position: 420 } });
  assert.match(play.playbackSequence(gap).reason, /shows "Between chapters", which lasts 50 s/);
  const late = book("late", { tracks: [{ duration: 3000, chapters }], progress: { position: 1950 } });
  assert.match(play.playbackSequence(late).reason, /the saved position is 50 s before the end of "B" \(needs more than 60 s\)/);
});

test("the selection's timeline is playbackTimeline from src/chapters.ts, as the slider computes it", () => {
  const chapters = [{ title: "A", start: 10, end: 400 }, { title: "B", start: 450 }];
  for (const position of [0, 5, 10, 200, 420, 460, 1500]) {
    const b = book(`t${position}`, { tracks: [{ duration: 3000, chapters }, { duration: 900 }], progress: { position } });
    const sequence = play.playbackSequence(b);
    const slider = playbackTimeline(b, b.tracks[0].id, position, b.tracks[0].duration, "chapter");
    if (sequence.reason) assert.ok(slider.duration < play.PLAYBACK_MIN_CHAPTER_SECONDS || slider.start + slider.duration - position <= 60, `${position}: ${sequence.reason}`);
    else assert.deepEqual(sequence.timeline, slider, `${position}`);
  }
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "live-check-playback.mjs"), "utf8");
  assert.match(source, /tsImport\("\.\.\/src\/chapters\.ts", import\.meta\.url\)/);
  assert.doesNotMatch(source, /listeningChapters|currentChapter|chapterAt/, "no parallel chapter computation");
});

test("playback selection: only a listing read successfully can be 'none qualifies'; other answers fail naming the request", async () => {
  const ok = book("ok", { progress: { position: 42 } });
  const finished = book("done", { progress: { position: 640 } });
  const serve = (answers) => async (path) => answers[path] ?? answer([]);
  const picked = await play.selectPlaybackRecording(serve({ "/api/books": answer([ok]) }));
  assert.equal(picked.recordingId, ok.recordingId);
  assert.deepEqual(picked.ebooks, []);
  await assert.rejects(play.selectPlaybackRecording(serve({ "/api/books": answer([finished]) })), NoSuitableRecording);
  for (const [path, bad] of [["/api/books", answer({}, 500)], ["/api/books", answer("<html>")], ["/api/books", answer({ books: [] })], ["/api/ebooks", answer({}, 401)], ["/api/ebooks", answer({ ebooks: [] })]]) {
    await assert.rejects(play.selectPlaybackRecording(serve({ "/api/books": answer([ok]), [path]: bad })), (error) => {
      assert.ok(!(error instanceof NoSuitableRecording), `${path} ${bad.status} ${bad.text}`);
      assert.ok(error.message.startsWith(`GET ${path} answered`), error.message);
      return true;
    });
  }
});

test("the playback check reads its recording through the selection and checks the slider against it (static)", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verify-playback-workflow.mjs"), "utf8");
  assert.match(source, /selectPlaybackRecording\(requestFrom\(context\),\{preferred,allowRecent\}\)/);
  assert.match(source, /^const \{preferred,allowRecent\}=verifyChoice\(\);$/m);
  assert.match(source, /if\(!\(chapterDuration>=PLAYBACK_MIN_CHAPTER_SECONDS\)\) throw/);
  assert.doesNotMatch(source, /context\.request\.get\(/, "every selection GET goes through requestFrom");
});

// #774: the playback check put the most recently listened book first, which is the one the owner is listening to.
test("#774: playback check: the book played an hour ago is skipped for the next most recently listened, with the reason", async () => {
  const NOW = 1795600000000, HOUR = 60 * 60 * 1000;
  const gate = book("torbox-139288314", { progress: { position: 42, updatedAt: NOW - HOUR } });
  const excession = book("excession", { progress: { position: 42, updatedAt: NOW - 3 * 24 * HOUR } });
  const older = book("older", { progress: { position: 42, updatedAt: NOW - 9 * 24 * HOUR } });
  const books = [gate, excession, older];
  const pick = play.pickPlaybackRecording({ books }, { now: NOW });
  assert.equal(pick.recordingId, excession.recordingId);
  const none = play.pickPlaybackRecording({ books: [gate] }, { now: NOW });
  assert.equal(none.reason, "1 recording(s) in the library, none qualifies: recording-torbox-139288314: listened to in the last 48 h");
  const get = async (path) => answer(path === "/api/books" ? books : []);
  await assert.rejects(play.selectPlaybackRecording(async (path) => answer(path === "/api/books" ? [gate] : []), { now: NOW }), NoSuitableRecording);
  await assert.rejects(play.selectPlaybackRecording(get, { preferred: gate.recordingId, now: NOW }), /^Error: refusing to check recording recording-torbox-139288314: listened to in the last 48 h/);
  assert.equal((await play.selectPlaybackRecording(get, { preferred: gate.recordingId, allowRecent: true, now: NOW })).recordingId, gate.recordingId);
  assert.equal((await play.selectPlaybackRecording(get, { preferred: older.recordingId, now: NOW })).recordingId, older.recordingId);
});
