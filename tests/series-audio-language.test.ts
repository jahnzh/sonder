// The series queue's automatic pick respects the series' language (#897). Real-shaped data: AudioBookBay's search
// result (`language` from `.postInfo`, narrator), Prowlarr's result (no language field; the title only), the French
// "Dungeon Crawler Carl [B0DM67WR2V].m4b" the queue once downloaded, and AudiobookDB's answers for an ASIN
// (tests/audiobookdb-fixture.ts).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-audio-language-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
const { createControl, fixtureFetch, seriesMember } = await import("./audiobookdb-fixture.ts");
const control = createControl();
let now = Date.parse("2026-11-25T12:00:00Z");
const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control), clock });
ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control), clock });
const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const audio = await import("../server/series-audio.ts");
const lang = await import("../server/release-language.ts");
const acquisition = await import("../server/series-acquisition.ts");
const check = await import("../server/series-language-check.ts");
const { getWorkMediaState } = await import("../server/work-media-state.ts");
const { parseProwlarrResults } = await import("../server/sources/prowlarr.ts");
const empty = async () => ({ results: [], page: 1, nextPage: null });
acquisition.setSeriesAcquisitionDeps({
  seriesAudioDeps: { abbSearch: empty, prowlarrSearch: empty, abbMagnetLink: async () => "", prowlarrMagnetLink: async () => "", cachedHashes: async () => new Set<string>(), log: () => {} },
  fetchEbooks: async () => ({ downloaded: [], skipped: null, failures: [] }),
  acquire: async () => ({}) as never,
});
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
});
beforeEach(() => {
  control.calls.length = 0;
  control.failNext.length = 0;
  control.offline = false;
});

const FRENCH_HASH = "f".repeat(40);
const ENGLISH_HASH = "e".repeat(40);
/** The release of the issue: a TorBox-cached Prowlarr result, no language named, no narrator. */
const frenchRelease = (): import("../server/series-audio.ts").SeriesAudioCandidate => ({
  source: "prowlarr",
  id: "prowlarr-french",
  title: "Dungeon Crawler Carl [B0DM67WR2V].m4b",
  format: "M4B",
  hash: FRENCH_HASH,
  cached: true,
  kind: "plain",
  query: "Dungeon Crawler Carl",
});
/** An English one: AudioBookBay's result for the same book, uncached, with its language and narrator. */
const englishRelease = (): import("../server/series-audio.ts").SeriesAudioCandidate => ({
  source: "abb",
  id: "dungeon-crawler-carl-matt-dinniman",
  title: "Dungeon Crawler Carl",
  format: "M4B",
  narrator: "Jeff Hays",
  language: "English",
  hash: ENGLISH_HASH,
  cached: false,
  kind: "plain",
  query: "Dungeon Crawler Carl",
});
const EXPECTED = { narrators: ["Jeff Hays"], lengthMs: 49_000_000 };
const OWN = ["Dungeon Crawler Carl"];

// ---- The language of a release ----
test("a language is read as its code from a name, a three-letter code or a locale", () => {
  assert.equal(lang.languageCode("French"), "fr");
  assert.equal(lang.languageCode("fra"), "fr");
  assert.equal(lang.languageCode("fr-CA"), "fr");
  assert.equal(lang.languageCode("Deutsch"), "de");
  assert.equal(lang.languageCode("en-GB"), "en");
  assert.equal(lang.languageCode("English"), "en");
  assert.equal(lang.languageCode(""), null);
  assert.deepEqual(lang.languagesNamed("English, French"), ["en", "fr"]);
  // A field that says nothing is no language: "Unknown" does not rule a release out.
  for (const field of ["Unknown", "?", "N/A", "Multi-language", ""]) assert.deepEqual(lang.languagesNamed(field), [], field);
  assert.equal(audio.candidateLanguageFits({ title: "Dungeon Crawler Carl", language: "Unknown" }, "en", OWN), "unnamed");
});

test("a title marks a language by a tag, the language's own name or its English name", () => {
  for (const [title, code] of [
    ["Dungeon Crawler Carl [FR]", "fr"],
    ["Dungeon Crawler Carl (French) M4B", "fr"],
    ["Dungeon Crawler Carl - Français - Livre audio", "fr"],
    ["Dungeon Crawler Carl VF", "fr"],
    ["Dungeon Crawler Carl [Deutsch]", "de"],
    ["Dungeon Crawler Carl German Unabridged", "de"],
    ["Dungeon Crawler Carl (Español) m4b", "es"],
    ["Dungeon Crawler Carl Italiano", "it"],
    ["Dungeon Crawler Carl [Dutch]", "nl"],
    ["Dungeon Crawler Carl Nederlands luisterboek", "nl"],
  ] as const)
    assert.deepEqual(lang.titleLanguages(title, { ownTitles: OWN }), [code], title);
  // No mark: the release of the issue names nothing, its ASIN is not a language.
  assert.deepEqual(lang.titleLanguages("Dungeon Crawler Carl [B0DM67WR2V].m4b", { ownTitles: OWN }), []);
  assert.deepEqual(lang.titleLanguages("Dungeon Crawler Carl [English] M4B", { ownTitles: OWN }), ["en"]);
  // A language word that is the book's own title is no mark.
  assert.deepEqual(lang.titleLanguages("The Dutch House - Ann Patchett M4B", { ownTitles: ["The Dutch House"] }), []);
  assert.deepEqual(lang.titleLanguages("The Dutch House - Ann Patchett M4B"), ["nl"], "without the work's titles the word counts");
});

test("a Prowlarr result carries a language only where its title marks one, and only by a mark that cannot be a title word", () => {
  const item = (title: string) => ({ guid: title, indexerId: 1, indexer: "Idx", title, size: 10, protocol: "torrent", infoHash: "a".repeat(40), categories: [{ id: 3030 }] });
  const { releases } = parseProwlarrResults([item("Dungeon Crawler Carl [FR] m4b"), item("Dungeon Crawler Carl [B0DM67WR2V].m4b"), item("The Dutch House audiobook m4b")]);
  assert.deepEqual(releases.map((release) => release.language), ["French", null, null]);
});

// ---- The rule ----
test("candidateLanguageFits: the source's language settles it, the title speaks where the source is silent", () => {
  const fits = (candidate: Partial<import("../server/series-audio.ts").SeriesAudioCandidate> & { title: string }, language = "en", own = OWN) => audio.candidateLanguageFits(candidate, language, own);
  assert.equal(fits({ title: "Dungeon Crawler Carl", language: "English" }), "fits");
  assert.equal(fits({ title: "Dungeon Crawler Carl", language: "French" }), "other");
  assert.equal(fits({ title: "Dungeon Crawler Carl [EN]", language: "German" }), "other", "the source's language wins");
  assert.equal(fits({ title: "Dungeon Crawler Carl", language: "French" }, "fr"), "fits");
  assert.equal(fits({ title: "Dungeon Crawler Carl [FR]" }), "other");
  assert.equal(fits({ title: "Dungeon Crawler Carl Deutsch" }), "other");
  assert.equal(fits({ title: "Dungeon Crawler Carl [English]" }), "fits");
  assert.equal(fits({ title: "Dungeon Crawler Carl [B0DM67WR2V].m4b" }), "unnamed");
  assert.equal(fits({ title: "Dungeon Crawler Carl [B0DM67WR2V].m4b", asinCheck: "other_language" }), "other");
  assert.equal(fits({ title: "Dungeon Crawler Carl [B0DM67WR2V].m4b", asinCheck: "same" }), "fits");
  assert.equal(fits({ title: "Dungeon Crawler Carl", language: "English, French" }), "fits");
  assert.equal(fits({ title: "Dungeon Crawler Carl" }, "fr"), "unnamed");
});

test("the French release of the issue, cached, loses to an uncached English one", () => {
  const picked = audio.pickAutoAcquireCandidate([frenchRelease(), englishRelease()], EXPECTED, "en", OWN);
  assert.equal(picked?.id, englishRelease().id);
});

test("a release with no language named and no evidence is left for the user (the French release alone)", () => {
  assert.equal(audio.pickAutoAcquireCandidate([frenchRelease()], EXPECTED, "en", OWN), null);
  assert.equal(audio.pickAutoAcquireCandidate([frenchRelease()], null, "en", OWN), null);
});

test("a source or a title that names another language is never picked, even with the narrator's name", () => {
  const named = (patch: Partial<import("../server/series-audio.ts").SeriesAudioCandidate>) => ({ ...englishRelease(), ...patch });
  for (const patch of [
    { language: "French" },
    { language: null, title: "Dungeon Crawler Carl [FR]" },
    { language: null, title: "Dungeon Crawler Carl Français" },
    { language: null, title: "Dungeon Crawler Carl VF" },
    { language: null, title: "Dungeon Crawler Carl German" },
    { language: null, title: "Dungeon Crawler Carl Deutsch" },
    { language: null, title: "Dungeon Crawler Carl Español" },
    { language: null, title: "Dungeon Crawler Carl Italiano" },
    { language: null, title: "Dungeon Crawler Carl Dutch" },
    { language: null, title: "Dungeon Crawler Carl Nederlands" },
  ])
    assert.equal(audio.pickAutoAcquireCandidate([named(patch)], EXPECTED, "en", OWN), null, JSON.stringify(patch));
});

test("a release with no language named is picked with the narrator's or the length's evidence", () => {
  const unnamed = (patch: Partial<import("../server/series-audio.ts").SeriesAudioCandidate>) => ({ ...frenchRelease(), ...patch });
  assert.equal(audio.pickAutoAcquireCandidate([unnamed({ narrator: "Hays, Jeff" })], EXPECTED, "en", OWN)?.id, "prowlarr-french");
  assert.equal(audio.pickAutoAcquireCandidate([unnamed({ narrator: "Someone Else" })], EXPECTED, "en", OWN), null);
  assert.equal(audio.pickAutoAcquireCandidate([unnamed({ lengthMs: 49_500_000 })], EXPECTED, "en", OWN)?.id, "prowlarr-french");
  assert.equal(audio.pickAutoAcquireCandidate([unnamed({ lengthMs: 30_000_000 })], EXPECTED, "en", OWN), null);
  assert.equal(audio.pickAutoAcquireCandidate([unnamed({ title: "Dungeon Crawler Carl - read by Jeff Hays - m4b" })], EXPECTED, "en", OWN)?.id, "prowlarr-french");
});

test("a series in French takes the French release and leaves the English one", () => {
  const french = { ...frenchRelease(), title: "Dungeon Crawler Carl [FR] m4b" };
  assert.equal(audio.pickAutoAcquireCandidate([french, englishRelease()], EXPECTED, "fr", OWN)?.id, "prowlarr-french");
});

// ---- The ASIN in the title ----
const lookup = (answers: Record<string, import("../server/series-audio.ts").AsinRelease | null | "throw">) => async (asin: string) => {
  const answer = answers[asin];
  if (answer === "throw") throw new Error("AudiobookDB is unreachable");
  return answer ?? null;
};
const quiet = { log: () => {} };

test("the ASIN of the French release names a French release: never picked, whatever it is cached", async () => {
  const candidates = [frenchRelease(), englishRelease()];
  await audio.resolveCandidateAsins(candidates, { language: "en", bookId: "bk-dcc-1", ownTitles: OWN }, { ...quiet, asinRelease: lookup({ B0DM67WR2V: { bookId: "bk-dcc-1", language: "French" } }) });
  assert.equal(candidates[0].asin, "B0DM67WR2V");
  assert.equal(candidates[0].asinCheck, "other_language");
  assert.equal(candidates[0].language, "French");
  assert.equal(audio.candidateLanguageFits(candidates[0], "en", OWN), "other");
  assert.equal(audio.pickAutoAcquireCandidate([candidates[0]], EXPECTED, "en", OWN), null);
});

test("an ASIN of a release in the series' language is the evidence a release with no language named needs", async () => {
  const candidate = { ...frenchRelease(), title: "Dungeon Crawler Carl [B0DCCENG01].m4b" };
  await audio.resolveCandidateAsins([candidate], { language: "en", bookId: "bk-dcc-1", ownTitles: OWN }, { ...quiet, asinRelease: lookup({ B0DCCENG01: { bookId: "bk-dcc-1", language: "English" } }) });
  assert.equal(candidate.asinCheck, "same");
  assert.equal(audio.pickAutoAcquireCandidate([candidate], null, "en", OWN)?.id, "prowlarr-french");
});

test("an ASIN of another book is not this book", async () => {
  const candidate = { ...frenchRelease(), title: "Carl's Doomsday Scenario [B0DCCBOOK2].m4b" };
  await audio.resolveCandidateAsins([candidate], { language: "en", bookId: "bk-dcc-1", ownTitles: OWN }, { ...quiet, asinRelease: lookup({ B0DCCBOOK2: { bookId: "bk-dcc-2", language: "English" } }) });
  assert.equal(candidate.asinCheck, "other_book");
  assert.equal(audio.pickAutoAcquireCandidate([candidate], EXPECTED, "en", OWN), null);
});

test("a lookup that fails or knows no language leaves the candidate as language not known", async () => {
  const failing = { ...frenchRelease() };
  await audio.resolveCandidateAsins([failing], { language: "en", ownTitles: OWN }, { ...quiet, asinRelease: lookup({ B0DM67WR2V: "throw" }) });
  assert.equal(failing.asinCheck, "unknown");
  assert.equal(audio.pickAutoAcquireCandidate([failing], EXPECTED, "en", OWN), null);
  const silent = { ...frenchRelease() };
  await audio.resolveCandidateAsins([silent], { language: "en", ownTitles: OWN }, { ...quiet, asinRelease: lookup({ B0DM67WR2V: { bookId: "bk-dcc-1", language: null } }) });
  assert.equal(silent.asinCheck, "unknown");
  const unknownAsin = { ...frenchRelease() };
  await audio.resolveCandidateAsins([unknownAsin], { language: "en", ownTitles: OWN }, { ...quiet, asinRelease: lookup({}) });
  assert.equal(unknownAsin.asinCheck, "unknown");
});

test("a candidate with no ASIN, one already in another language and a compilation are not looked up; lookups are capped", async () => {
  const asked: string[] = [];
  const asinRelease = async (asin: string) => {
    asked.push(asin);
    return { bookId: "bk-dcc-1", language: "English" };
  };
  const plain = englishRelease();
  const marked = { ...frenchRelease(), title: "Dungeon Crawler Carl [FR] [B0DM67WR2V]" };
  const box = { ...frenchRelease(), title: "Dungeon Crawler Carl Books 1-3 [B0DCCBOX001]", kind: "compilation" as const };
  await audio.resolveCandidateAsins([plain, marked, box], { language: "en", ownTitles: OWN }, { ...quiet, asinRelease });
  assert.deepEqual(asked, []);
  const many = Array.from({ length: 9 }, (_, i) => ({ ...frenchRelease(), id: `m${i}`, title: `Dungeon Crawler Carl [B0DCCMANY${i}]` }));
  await audio.resolveCandidateAsins(many, { language: "en", ownTitles: OWN }, { ...quiet, asinRelease });
  assert.equal(asked.length, 6);
});

test("audiobookDbAsinRelease reads the release's language from AudiobookDB's answers", async () => {
  assert.deepEqual(await audio.audiobookDbAsinRelease("B0DM67WR2V"), { bookId: "bk-dcc-1", language: "fr" });
  assert.deepEqual(await audio.audiobookDbAsinRelease("B0DCCENG01"), { bookId: "bk-dcc-1", language: "en" });
  assert.equal(await audio.audiobookDbAsinRelease("B0NOSUCH001"), null);
  // Through the real lookup: the French release of the issue is not picked, and the book is not the one of book 2.
  const candidates = [frenchRelease(), englishRelease()];
  await audio.resolveCandidateAsins(candidates, { language: "en", bookId: "bk-dcc-1", ownTitles: OWN }, quiet);
  assert.equal(candidates[0].asinCheck, "other_language");
  assert.equal(audio.pickAutoAcquireCandidate(candidates, EXPECTED, "en", OWN)?.id, englishRelease().id);
  const second = [{ ...frenchRelease(), title: "Carl's Doomsday Scenario [B0DCCBOOK2].m4b" }];
  await audio.resolveCandidateAsins(second, { language: "en", bookId: "bk-dcc-1", ownTitles: OWN }, quiet);
  assert.equal(second[0].asinCheck, "other_book");
});

// ---- The queue's pick end to end ----
function workRow(workId: string, title: string) {
  sqlite.prepare("INSERT OR IGNORE INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)").run(workId, title, "Matt Dinniman", "", "Audiobook", 2020);
}
const volumeInput = (workId: string) => {
  const refs = audio.seriesVolumeRefs([{ position: 1, title: "Dungeon Crawler Carl" }], "Dungeon Crawler Carl");
  return { seriesName: "Dungeon Crawler Carl", author: "Matt Dinniman", workId, volume: refs[0], allVolumes: refs, title: "Dungeon Crawler Carl", expected: EXPECTED, bookId: "bk-dcc-1" };
};
function searchDeps(results: { prowlarr: unknown[]; abb: unknown[] }, extra: Partial<import("../server/series-audio.ts").SeriesAudioSearchDeps> = {}) {
  const magnet = (hash: string) => `magnet:?xt=urn:btih:${hash}&dn=x`;
  return {
    abbSearch: (async () => ({ results: results.abb, page: 1, nextPage: null })) as never,
    prowlarrSearch: (async () => ({ results: results.prowlarr, page: 1, nextPage: null })) as never,
    abbMagnetLink: async () => magnet(ENGLISH_HASH),
    prowlarrMagnetLink: async () => magnet(FRENCH_HASH),
    cachedHashes: async (hashes: string[]) => new Set(hashes.filter((hash) => hash === FRENCH_HASH)),
    log: () => {},
    ...extra,
  } as import("../server/series-audio.ts").SeriesAudioSearchDeps;
}
const PROWLARR_FRENCH = { id: "prowlarr-french", title: "Dungeon Crawler Carl [B0DM67WR2V].m4b", infoHash: FRENCH_HASH, size: "1 GB", format: "M4B" };
const ABB_ENGLISH = { id: "dungeon-crawler-carl-matt-dinniman", title: "Dungeon Crawler Carl", size: "1 GB", format: "M4B", narrator: "Jeff Hays", language: "English" };

test("the queue downloads the English release, not the cached French one", async () => {
  workRow("w-pick-en", "Dungeon Crawler Carl");
  const magnets: string[] = [];
  await audio.autoAcquireSeriesVolume(1, volumeInput("w-pick-en"), async (magnet) => void magnets.push(magnet), searchDeps({ prowlarr: [PROWLARR_FRENCH], abb: [ABB_ENGLISH] }, { asinRelease: lookup({ B0DM67WR2V: { bookId: "bk-dcc-1", language: "French" } }) }));
  assert.deepEqual(magnets.map((magnet) => /btih:(\w+)/.exec(magnet)?.[1]), [ENGLISH_HASH]);
});

test("with only the French release the queue downloads nothing and the book is left to choose", async () => {
  workRow("w-pick-fr", "Dungeon Crawler Carl");
  let acquired = 0;
  const state = await audio.autoAcquireSeriesVolume(1, volumeInput("w-pick-fr"), async () => void acquired++, searchDeps({ prowlarr: [PROWLARR_FRENCH], abb: [] }, { asinRelease: lookup({ B0DM67WR2V: { bookId: "bk-dcc-1", language: "French" } }) }));
  assert.equal(acquired, 0);
  assert.equal(state?.holdReason, "empty_search");
  // The ASIN could not be looked up: the release names no language and nothing says it is the wanted edition.
  workRow("w-pick-fr2", "Dungeon Crawler Carl");
  await audio.autoAcquireSeriesVolume(1, volumeInput("w-pick-fr2"), async () => void acquired++, searchDeps({ prowlarr: [PROWLARR_FRENCH], abb: [] }, { asinRelease: lookup({ B0DM67WR2V: "throw" }) }));
  assert.equal(acquired, 0);
  // A series in French takes what its ASIN says is a French release.
  workRow("w-pick-fr3", "Dungeon Crawler Carl");
  await audio.autoAcquireSeriesVolume(1, { ...volumeInput("w-pick-fr3"), seriesLanguage: "fr" }, async () => void acquired++, searchDeps({ prowlarr: [PROWLARR_FRENCH], abb: [ABB_ENGLISH] }, { asinRelease: lookup({ B0DM67WR2V: { bookId: "bk-dcc-1", language: "French" } }) }));
  assert.equal(acquired, 1);
});

test("the search keeps AudioBookBay's language on its candidates", async () => {
  const refs = audio.seriesVolumeRefs([{ position: 1, title: "Dungeon Crawler Carl" }], "Dungeon Crawler Carl");
  const found = await audio.searchVolumeAudioCandidates(refs[0], "Dungeon Crawler Carl", "Matt Dinniman", refs, searchDeps({ prowlarr: [], abb: [ABB_ENGLISH, { ...ABB_ENGLISH, id: "carl-fr", language: "French" }] }));
  assert.deepEqual(found.map((candidate) => candidate.language).sort(), ["English", "French"]);
});

// ---- The language of the series ----
test("the language chosen when saving a series is kept and decides the pick; the catalogue's language and English follow", async () => {
  control.series.set("sr-lang", { id: "sr-lang", name: "Language Series", people: [{ name: "Ada North", role: { name: "Author" } }], books: [seriesMember("bk-lang-1", "Language One", "Ada North", "1", 1)] });
  control.openLibrarySeries.set("language series", []);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-password" } });
  const cookies = { sonder_session: login.cookies[0].value };
  const saved = await app.inject({ method: "POST", url: "/api/series", cookies, payload: { id: "sr-lang", bookIds: ["bk-lang-1"], language: "fr-CA" } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(sqlite.prepare("SELECT language FROM user_saved_series WHERE user_id=1 AND series_id='sr-lang'").pluck().get(), "fr");
  assert.equal(audio.seriesAudioLanguage(1, "sr-lang", "en"), "fr");
  // A later save without a language (an older client) leaves it.
  const again = await app.inject({ method: "POST", url: "/api/series", cookies, payload: { id: "sr-lang", bookIds: ["bk-lang-1"] } });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(audio.seriesAudioLanguage(1, "sr-lang", "en"), "fr");
  sqlite.prepare("UPDATE user_saved_series SET language=NULL WHERE series_id='sr-lang'").run();
  assert.equal(audio.seriesAudioLanguage(1, "sr-lang", "de"), "de", "the catalogue's language when none was chosen");
  assert.equal(audio.seriesAudioLanguage(1, "sr-lang", null), "en", "English when nothing says");
  assert.equal(audio.seriesAudioLanguage(1, "sr-nothing", undefined), "en");
});

// ---- After the download ----
function downloaded(workId: string, fileName: string, language: string | null = null) {
  workRow(workId, "Dungeon Crawler Carl");
  const editionId = `edition-${workId}`;
  db.insert(s.editions).values({ id: editionId, workId, cover: "/covers/time.svg", narrator: "Unknown narrator", rating: 0, sourceLabel: "Your server · HDD", releaseTitle: fileName }).run();
  db.insert(s.recordings).values({ id: `recording-${editionId}`, editionId }).run();
  db.insert(s.tracks).values({ id: `track-${editionId}`, recordingId: `recording-${editionId}`, title: fileName, index: 0, duration: 60, source: "/dev/null", sourceType: "local" }).run();
  const acquisitionId = randomUUID();
  db.insert(s.acquisitions)
    .values({ id: acquisitionId, hash: acquisitionId.replaceAll("-", ""), magnet: "magnet:?xt=urn:btih:" + "1".repeat(40), backend: "local", title: fileName, author: "Matt Dinniman", cover: "/covers/time.svg", workId, language, status: "ready", progress: 1, bookId: editionId, createdAt: Date.now(), updatedAt: Date.now() })
    .run();
  db.insert(s.userAcquisitions).values({ userId: 1, acquisitionId }).run();
  return acquisitionId;
}
function savedSeriesWith(seriesId: string, workId: string, language: string | null) {
  sqlite.prepare("INSERT OR IGNORE INTO series_catalogue(id,name,author,book_count) VALUES(?,?,?,?)").run(seriesId, "Dungeon Crawler Carl", "Matt Dinniman", 1);
  sqlite.prepare("INSERT OR REPLACE INTO series_catalogue_works(series_id,book_id,work_id,title,position,provider,language) VALUES(?,?,?,?,?,?,?)").run(seriesId, `bk-${workId}`, workId, "Dungeon Crawler Carl", 1, "audiobookdb", "en");
  sqlite.prepare("INSERT OR REPLACE INTO user_saved_series(user_id,series_id,saved_at,language) VALUES(1,?,?,?)").run(seriesId, Date.now(), language);
  sqlite.prepare("INSERT OR REPLACE INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(1,?,?,?,1)").run(seriesId, `bk-${workId}`, workId);
}

test("a downloaded series book whose files carry the ASIN of a French release is marked another language", async () => {
  const acquisitionId = downloaded("w-dl-fr", "Dungeon Crawler Carl [B0DM67WR2V].m4b");
  savedSeriesWith("sr-dl-fr", "w-dl-fr", "en");
  assert.deepEqual(await check.checkDownloadedLanguage(acquisitionId), ["w-dl-fr"], "through AudiobookDB's own answers");
  const state = getWorkMediaState(1, "w-dl-fr");
  assert.equal(state?.state, "available");
  assert.equal(state?.holdReason, "another_language");
});

test("a book is not marked when its ASIN is of the series' language, of no known release, or absent, or the lookup fails", async () => {
  const english = downloaded("w-dl-en", "Dungeon Crawler Carl [B0DCCENG01].m4b");
  savedSeriesWith("sr-dl-en", "w-dl-en", "en");
  assert.deepEqual(await check.checkDownloadedLanguage(english), []);
  const unknown = downloaded("w-dl-unknown", "Dungeon Crawler Carl [B0NOSUCH001].m4b");
  savedSeriesWith("sr-dl-unknown", "w-dl-unknown", "en");
  assert.deepEqual(await check.checkDownloadedLanguage(unknown), []);
  const none = downloaded("w-dl-none", "Dungeon Crawler Carl.m4b");
  savedSeriesWith("sr-dl-none", "w-dl-none", "en");
  assert.deepEqual(await check.checkDownloadedLanguage(none, async () => ({ bookId: null, language: "French" })), []);
  const failing = downloaded("w-dl-fail", "Dungeon Crawler Carl [B0DM67WR2V].m4b");
  savedSeriesWith("sr-dl-fail", "w-dl-fail", "en");
  assert.deepEqual(await check.checkDownloadedLanguage(failing, async () => { throw new Error("down"); }), []);
  for (const workId of ["w-dl-en", "w-dl-unknown", "w-dl-none", "w-dl-fail"]) assert.equal(getWorkMediaState(1, workId)?.holdReason ?? null, null, workId);
  // A series in French wants this release; and a book that is in no saved series is not checked.
  const french = downloaded("w-dl-fr-ok", "Dungeon Crawler Carl [B0DM67WR2V].m4b");
  savedSeriesWith("sr-dl-fr-ok", "w-dl-fr-ok", "fr");
  assert.deepEqual(await check.checkDownloadedLanguage(french), []);
  const loose = downloaded("w-dl-loose", "Dungeon Crawler Carl [B0DM67WR2V].m4b");
  assert.deepEqual(await check.checkDownloadedLanguage(loose), []);
});
