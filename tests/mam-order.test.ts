// The owner's order of sources (#911), for audiobooks and ebooks alike: a release TorBox has cached first (from any
// source), then MyAnonamouse, then every other source, in the Get sheets' lists and in the series queue's automatic
// pick. MAM's rows from the recorded search answer (tests/fixtures/myanonamouse/). Also the lines MAM's rows, its
// Settings group and its Activity rows say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-mam-order-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";

const audio = await import("../server/series-audio.ts");
const { parseMamSearch, mamAudiobookRelease, mamEbookResult } = await import("../server/sources/myanonamouse.ts");
const { sortReleases, mergeReleases } = await import("../src/releases.ts");
const { getLine, sourceLink, MAM_LINE, recordingRows } = await import("../src/pages/get-audiobook-rows.ts");
const { audiobookSources } = await import("../src/pages/get-audiobook-state.ts");
const { ebookSources } = await import("../src/pages/get-ebook-state.ts");
const { editionRows, getEditionLine, editionSource, LINE_MAM } = await import("../src/pages/get-ebook-rows.ts");
const { mamSeedingLine, seedingTime } = await import("../src/pages/activity-server-lines.ts");
const { mamStatus, mamRefusedLine } = await import("../src/settings-server.ts");
const { connectionsValue } = await import("../src/settings-list.ts");

const fixture = (name: string) => readFileSync(new URL(`./fixtures/myanonamouse/${name}`, import.meta.url), "utf8");
const MAM_AUDIO = parseMamSearch(fixture("audio-search.json")).results;
const MAM_EBOOKS = parseMamSearch(fixture("ebook-search.json")).results;

type Candidate = import("../server/series-audio.ts").SeriesAudioCandidate;
const candidate = (over: Partial<Candidate>): Candidate => ({
  source: "abb", id: "x", title: "Dungeon Crawler Carl", kind: "plain", query: "q", language: "English", ...over,
});

test("the queue's pick: TorBox's cached copy first, then MyAnonamouse's, then the others, whatever else ranks them", () => {
  const expected = { narrators: ["Jeff Hays"], lengthMs: null };
  const cached = candidate({ source: "prowlarr", id: "p1", hash: "a".repeat(40), cached: true, narrator: null });
  // A MAM torrent has no hash until its .torrent is fetched: it can still be picked.
  const mam = candidate({ source: "mam", id: "1097985", narrator: "Jeff Hays" });
  const abb = candidate({ source: "abb", id: "abb-1", hash: "b".repeat(40), narrator: "Jeff Hays", format: "M4B" });
  assert.equal(audio.pickAutoAcquireCandidate([abb, mam, cached], expected)?.id, "p1");
  assert.equal(audio.pickAutoAcquireCandidate([abb, mam], expected)?.id, "1097985");
  // A MAM upload with no evidence of the wanted edition (another narrator) never wins over one that has it.
  assert.equal(audio.pickAutoAcquireCandidate([abb, { ...mam, narrator: "Someone Else" }], expected)?.id, "abb-1");
  // With nothing known of the edition, MAM's comes before the others'.
  assert.equal(audio.pickAutoAcquireCandidate([abb, { ...mam, narrator: "Someone Else" }], null)?.id, "1097985");
  // MAM's names the series' language: another language is never picked (#897).
  assert.equal(audio.pickAutoAcquireCandidate([candidate({ source: "mam", id: "1222742", language: "German" }), abb], expected)?.id, "abb-1");
  assert.equal(audio.sourceTier(cached), 0);
  assert.equal(audio.sourceTier(mam), 1);
  assert.equal(audio.sourceTier(abb), 2);
});

test("the pack pick: the most waiting books first, then TorBox's cached copy, MyAnonamouse's, then the others", () => {
  const volumes = [1, 2, 3, 4].map((position) => ({ position, title: `Book ${position}` }));
  const pack = (over: Partial<Candidate>) => candidate({ kind: "compilation", title: "Dungeon Crawler Carl Books 1-3", ...over });
  const wanted = new Set([1, 2, 3]);
  const mam = pack({ source: "mam", id: "555" });
  const abb = pack({ source: "abb", id: "abb-pack", hash: "c".repeat(40) });
  assert.equal(audio.pickSeriesPack([abb, mam], volumes, "Dungeon Crawler Carl", wanted)?.candidate.id, "555");
  const cached = pack({ source: "prowlarr", id: "cached-pack", hash: "d".repeat(40), cached: true });
  assert.equal(audio.pickSeriesPack([abb, mam, cached], volumes, "Dungeon Crawler Carl", wanted)?.candidate.id, "cached-pack");
});

test("the series search asks MyAnonamouse once per book; its rows of the book join by their series place, with language and narrator", async () => {
  const asked: string[] = [];
  const magnets: string[] = [];
  const refs = audio.seriesVolumeRefs([{ position: 1, title: "Dungeon Crawler Carl" }, { position: 2, title: "Carl's Doomsday Scenario" }], "Dungeon Crawler Carl");
  const found = await audio.searchVolumeAudioCandidates(refs[0], "Dungeon Crawler Carl", "Matt Dinniman", refs, {
    abbSearch: async () => ({ results: [], page: 1, nextPage: null }),
    prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
    abbMagnetLink: async (id) => (magnets.push(id), ""),
    prowlarrMagnetLink: async (id) => (magnets.push(id), ""),
    cachedHashes: async (hashes) => {
      assert.deepEqual(hashes, []);
      return new Set();
    },
    mamSearch: async (q) => {
      asked.push(q);
      return { results: audio.mamSeriesRows(MAM_AUDIO) };
    },
    log: () => {},
  });
  assert.equal(asked.length, 1);
  // No magnet is asked of a MAM row: its .torrent is fetched only for the one got.
  assert.deepEqual(magnets, []);
  const first = found.find((entry) => entry.id === "1097985")!;
  assert.equal(first.source, "mam");
  assert.equal(first.narrator, "Jeff Hays");
  assert.equal(first.language, "English");
  assert.equal(first.kind, "plain");
  // The German upload is a candidate too, named German, so the pick leaves it.
  assert.equal(found.find((entry) => entry.id === "1222742")?.language, "German");
  const picked = audio.pickAutoAcquireCandidate(found, { narrators: ["Jeff Hays"], lengthMs: null });
  assert.equal(picked?.id, "1097985");
});

test("a MAM row is the book by its series place, else by its title, and never by another author", () => {
  const refs = audio.seriesVolumeRefs([{ position: 1, title: "Dungeon Crawler Carl" }, { position: 2, title: "Carl's Doomsday Scenario" }], "Dungeon Crawler Carl");
  const row = audio.mamSeriesRows(MAM_AUDIO)[0];
  assert.equal(audio.mamVolume(row, refs, "Dungeon Crawler Carl", "Matt Dinniman"), 1);
  assert.equal(audio.mamVolume({ ...row, series: [{ name: "Dungeon Crawler Carl", position: "2" }] }, refs, "Dungeon Crawler Carl", "Matt Dinniman"), 2);
  assert.equal(audio.mamVolume(row, refs, "Dungeon Crawler Carl", "Someone Else"), null);
});

test("the Get audiobook sheet: MyAnonamouse asked first; rows of the book, TorBox's cached ones, then MAM's, then by seeders", () => {
  assert.deepEqual(audiobookSources({ prowlarr: true, mam: true }), ["mam", "abb", "prowlarr"]);
  assert.deepEqual(audiobookSources({ prowlarr: false }), ["abb"]);
  const mam = mamAudiobookRelease(MAM_AUDIO[0]);
  const base = { author: "Matt Dinniman", url: "", narrator: null, format: null, bitrate: null, posted: null, uploader: null, description: "", language: "English" };
  const abbSeeded = { ...base, id: "abb-1", title: "Dungeon Crawler Carl", source: "abb" as const, seeders: 99999, size: "700 MB" };
  const cached = { ...base, id: "prowlarr-1", title: "Dungeon Crawler Carl", source: "prowlarr" as const, cached: true, seeders: 1, size: "800 MB", infoHash: "e".repeat(40) };
  const other = { ...base, id: "abb-2", title: "Something Else Entirely", source: "abb" as const, seeders: 5, size: "1 GB" };
  const sorted = sortReleases([other, abbSeeded, mam, cached], "Dungeon Crawler Carl").map((release) => release.id);
  assert.deepEqual(sorted, ["prowlarr-1", "mam-1097985", "abb-1", "abb-2"]);
  // A MAM row never merges with another source's listing of the same files: it is got another way.
  assert.equal(mergeReleases([{ ...abbSeeded, size: mam.size }, mam]).length, 2);
  const rows = recordingRows([mam], "Dungeon Crawler Carl");
  assert.equal(rows[0].first, "Jeff Hays");
  assert.match(rows[0].edge?.text ?? "", /seeders/);
});

test("the line under Get this recording and the link for a MAM row", () => {
  const ok = { status: "ok", message: "" } as const;
  const down = { status: "unreachable", message: "The local torrent client cannot be reached." } as const;
  assert.equal(getLine({ chosen: { source: "mam", cached: false }, mediaState: null, torboxConnected: true, health: ok })?.text, MAM_LINE);
  assert.deepEqual(getLine({ chosen: { source: "mam" }, mediaState: null, torboxConnected: true, health: down }), { text: down.message, failed: true, replaceActive: false });
  assert.deepEqual(sourceLink({ source: "mam", url: "https://www.myanonamouse.net/t/1097985" }), { text: "On MyAnonamouse", href: "https://www.myanonamouse.net/t/1097985" });
});

test("the Get ebook sheet: MyAnonamouse asked first; EPUBs first, each TorBox's cached ones, then MAM's, then the others", () => {
  assert.deepEqual(ebookSources({ prowlarr: true, mam: true }).slice(0, 2), ["mam", "libgen"]);
  assert.equal(ebookSources({ prowlarr: true })[0], "libgen");
  const mamRows = MAM_EBOOKS.flatMap((release) => mamEbookResult(release) ?? []);
  const libgen = { md5: "1".repeat(32), source: "libgen" as const, title: "Dungeon Crawler Carl", authors: ["Matt Dinniman"], extension: "epub" as const, language: "English", size: null, year: null, coverUrl: null, url: "" };
  const cached = { ...libgen, md5: "2".repeat(32), source: "prowlarr" as const, cached: true };
  const rows = editionRows([libgen, ...mamRows, cached], new Set());
  const epubs = rows.filter((row) => row.result.extension === "epub").map((row) => row.result.source);
  assert.deepEqual(epubs.slice(0, 2), ["prowlarr", "mam"]);
  assert.equal(epubs[epubs.length - 1], "libgen");
  const mam = mamRows.find((row) => row.extension === "epub")!;
  assert.match(editionSource(mam), /^MyAnonamouse · \d+ seeders$/);
  assert.equal(getEditionLine(mam, null), LINE_MAM);
});

test("Settings: MyAnonamouse's status, the line when it refused the session, and the Connections summary", () => {
  assert.equal(mamStatus(null), "Not set up");
  assert.equal(mamStatus({ mamConfigured: true, mamRefusedAt: null }), "Session saved");
  assert.equal(mamStatus({ mamConfigured: true, mamRefusedAt: Date.UTC(2026, 10, 25) }), "Refused");
  assert.match(mamRefusedLine(Date.UTC(2026, 10, 25, 12), "en-GB"), /^MyAnonamouse refused this session on 25 Nov\. Make a new session/);
  assert.equal(connectionsValue({ torboxConfigured: true, mamConfigured: true }), "TorBox, MyAnonamouse");
});

test("Activity: each MAM torrent's seeding time against its 72 hours, and its ratio", () => {
  const torrent = { id: "a", title: "Dungeon Crawler Carl", progress: 1, seededEnough: false };
  assert.equal(mamSeedingLine({ ...torrent, state: "seeding", secondsSeeding: 31 * 3600, ratio: 0.42 }), "Seeding · 31 h of 72 h · Ratio 0.42");
  assert.equal(mamSeedingLine({ ...torrent, state: "seeding", secondsSeeding: 76 * 3600, ratio: 1.2, seededEnough: true }), "Seeding · 3 d 4 h · Ratio 1.20");
  assert.equal(mamSeedingLine({ ...torrent, state: "downloading", progress: 0.456, secondsSeeding: 0, ratio: null }), "Downloading 45%");
  assert.equal(mamSeedingLine({ ...torrent, state: "stopped", secondsSeeding: 600, ratio: 0 }), "Stopped in the torrent client · Seeded 10 min of 72 h · Ratio 0.00");
  assert.equal(mamSeedingLine({ ...torrent, state: "missing", secondsSeeding: null, ratio: null }), "Not in the torrent client");
  assert.equal(seedingTime(48 * 3600), "2 d");
});
