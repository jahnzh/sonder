// Discover's read of the server's works (#573): `GET /api/works`, the `workId` and `onServer` of
// `GET /api/discover/hardcover`'s hits and the `saved` of `GET /api/discover/series`, on a throwaway
// database, read as the owner (the administrator), Sam and Kim (two users who are not).
//
// Works, in the order they are made (the newest last):
// - w-matter "Matter" (Iain M. Banks): a recording with a file; in the owner's library; matched to Hardcover 1001.
// - w-windward "Look to Windward": a recording; in the owner's library.
// - w-wasp "The Wasp Factory" (Iain Banks): a streamed recording; in nobody's library.
// - w-cafe "Bjørn's Café" (Ana Núñez): an EPUB only.
// - w-sam-shelf "Excession": only a placeholder, in Sam's library; matched to Hardcover 1002.
// - w-sam-ebook "Inversions": a placeholder in Sam's library and an EPUB.
// - w-consensus "The Player of Games": a placeholder in Sam's library and only an ebook set's consensus text.
// - w-consensus-only "The Bridge" (Iain Banks): no audio edition, only a consensus text.
// - w-removed "Walking on Glass" (Iain Banks): a recording, removed by the owner.
// - 35 works "Limit Book <n>" by "Limit Author", without files.
// - w-new "Transition" (Iain Banks): a recording, made last.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkResult } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-discover-works-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = "owner-token";
const SAM = "sam-token";
const KIM = "kim-token";
const T0 = Date.UTC(2026, 0, 1);

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const { CONSENSUS_EBOOK_PREFIX } = await import("../server/ebook-set-consensus.ts");
{
  const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
  const media = join(process.env.MEDIA_ROOT, "fixture");
  mkdirSync(media, { recursive: true });
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(2,'sam',NULL,'user',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(3,'kim',NULL,'user',?)", T0);
  for (const [token, userId] of [[OWNER, 1], [SAM, 2], [KIM, 3]] as const)
    run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(token), Date.now() + 86_400_000, userId);
  const work = (id: string, title: string, author: string, year = 2000) =>
    run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)", id, title, author, "", "Fiction", year);
  const edition = (id: string, workId: string, cover: string) =>
    run(
      "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,?,?,?,?)",
      id,
      workId,
      cover,
      "Narrator",
      "en",
      null,
      0,
      "Test",
    );
  /** A real audio edition: a recording with one track, a local file or a stream. */
  const audio = (editionId: string, workId: string, local = true) => {
    edition(editionId, workId, `/covers/${editionId}.jpg`);
    run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${editionId}`, editionId);
    const source = local ? join(media, `${editionId}.mp3`) : `https://audio.example/${editionId}.mp3`;
    if (local) writeFileSync(source, "audio");
    run(
      "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,?,?,?,?,?,?)",
      `t-${editionId}`,
      `rec-${editionId}`,
      "Part 1",
      0,
      600,
      source,
      local ? "local" : "remote",
      "[]",
    );
  };
  /** A placeholder: an audio edition whose recording has no track. */
  const placeholder = (editionId: string, workId: string) => {
    edition(editionId, workId, `https://assets.hardcover.app/${editionId}.jpg`);
    run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `recording-${editionId}`, editionId);
  };
  const ebook = (id: string, workId: string) => {
    const source = join(media, `${id.replace(/[^a-z0-9-]/gi, "_")}.epub`);
    writeFileSync(source, "epub");
    run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,?,?)", id, workId, "epub", source);
  };
  const shelf = (userId: number, editionId: string, addedAt: number) =>
    run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", userId, editionId, addedAt);

  work("w-matter", "Matter", "Iain M. Banks", 2008);
  audio("ed-matter", "w-matter");
  shelf(1, "ed-matter", T0);
  run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-matter',1001,'matter','[]')");
  work("w-windward", "Look to Windward", "Iain M. Banks");
  audio("ed-windward", "w-windward");
  shelf(1, "ed-windward", T0 + 1);
  work("w-wasp", "The Wasp Factory", "Iain Banks", 1984);
  audio("ed-wasp", "w-wasp", false);
  work("w-cafe", "Bjørn's Café", "Ana Núñez");
  ebook("eb-cafe", "w-cafe");
  work("w-sam-shelf", "Excession", "Iain M. Banks");
  placeholder("hc-1002", "w-sam-shelf");
  shelf(2, "hc-1002", T0 + 2);
  run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-sam-shelf',1002,'excession','[]')");
  work("w-sam-ebook", "Inversions", "Iain M. Banks");
  placeholder("hc-1003", "w-sam-ebook");
  shelf(2, "hc-1003", T0 + 3);
  ebook("eb-inversions", "w-sam-ebook");
  work("w-consensus", "The Player of Games", "Iain M. Banks");
  placeholder("hc-1005", "w-consensus");
  shelf(2, "hc-1005", T0 + 4);
  ebook(`${CONSENSUS_EBOOK_PREFIX}w-consensus`, "w-consensus");
  work("w-consensus-only", "The Bridge", "Iain Banks");
  ebook(`${CONSENSUS_EBOOK_PREFIX}w-consensus-only`, "w-consensus-only");
  work("w-removed", "Walking on Glass", "Iain Banks");
  audio("ed-removed", "w-removed");
  for (let n = 1; n <= 35; n++) work(`w-limit-${n}`, `Limit Book ${n}`, "Limit Author");
  work("w-new", "Transition", "Iain Banks", 2009);
  audio("ed-new", "w-new");
  run("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(5501,'Culture','Iain M. Banks',10)");
  run("INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(2,5501,?)", T0);
}

// Hardcover, answered from the recorded search in `tests/fixtures/hardcover-search-banks.json`.
const recordedSearch = JSON.parse(readFileSync(new URL("./fixtures/hardcover-search-banks.json", import.meta.url), "utf8"));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.hardcover.app/")) return realFetch(input, init);
  const { query } = JSON.parse(String(init?.body));
  if (query.includes("SonderSearchLinks"))
    return Response.json({
      data: { books: recordedSearch.hits.map((hit: { document: { id: string; slug: string } }) => ({ id: Number(hit.document.id), slug: hit.document.slug })) },
    });
  if (query.includes("SonderSearch(")) return Response.json({ data: { search: { results: structuredClone(recordedSearch) } } });
  if (query.includes("SonderSeriesSearchDetails"))
    return Response.json({
      data: {
        series: [
          { id: 5502, name: "Culture", books_count: 2, author: { name: "Someone Else" }, book_series: [] },
          { id: 5501, name: "Culture", books_count: 10, author: { name: "Iain M. Banks" }, book_series: [] },
        ],
      },
    });
  if (query.includes("SonderSeriesSearch")) return Response.json({ data: { search: { ids: [5501, 5502] } } });
  return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
};

const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });

after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
});

const request = (token: string, url: string, method: "GET" | "PUT" | "DELETE" = "GET", payload?: Record<string, unknown>) =>
  payload === undefined
    ? app.inject({ method, url, cookies: { sonder_session: token } })
    : app.inject({ method, url, cookies: { sonder_session: token }, payload });

// The owner removes Walking on Glass the way the Book page does (it was never in the library).
{
  const removed = await request(OWNER, "/api/works/w-removed/library", "DELETE");
  assert.equal(removed.statusCode, 200, removed.body);
}

async function works(token: string, q?: string) {
  const response = await request(token, q === undefined ? "/api/works" : `/api/works?q=${encodeURIComponent(q)}`);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { works: WorkResult[] };
  assert.deepEqual(Object.keys(body), ["works"]);
  return body.works;
}
const ids = (list: WorkResult[]) => list.map((work) => work.workId);

test("a search matches every word in the title or the author, ignoring case and accents", async () => {
  assert.deepEqual(ids(await works(OWNER, "MATTER banks")), ["w-matter"]);
  assert.deepEqual(ids(await works(OWNER, "iain wasp")), ["w-wasp"]);
  assert.deepEqual(ids(await works(OWNER, "banks matter excession")), []);
  for (const q of ["nunez cafe", "NÚÑEZ", "bjorn", "BJØRN café", "bjørn's"])
    assert.deepEqual(ids(await works(OWNER, q)), ["w-cafe"], q);
  assert.deepEqual(ids(await works(OWNER, "  walking   GLASS ")), ["w-removed"], "a removed work is still found by a search");
});

test("a search lists the user's library works first, then by title", async () => {
  assert.deepEqual(ids(await works(OWNER, "banks")), [
    "w-windward",
    "w-matter",
    "w-sam-shelf",
    "w-sam-ebook",
    "w-consensus-only",
    "w-consensus",
    "w-wasp",
    "w-new",
    "w-removed",
  ]);
  const sam = await works(SAM, "banks");
  assert.deepEqual(ids(sam), [
    "w-sam-shelf",
    "w-sam-ebook",
    "w-consensus",
    "w-windward",
    "w-matter",
    "w-consensus-only",
    "w-wasp",
    "w-new",
    "w-removed",
  ]);
  assert.deepEqual(
    sam.filter((work) => work.inLibrary).map((work) => work.workId),
    ["w-sam-shelf", "w-sam-ebook", "w-consensus"],
    "inLibrary is Sam's own, not the owner's",
  );
});

test("a work whose only audio is a placeholder hidden from the user, and that has no ebook, is left out", async () => {
  // Kim may not see Sam's placeholders; Inversions has an ebook, so it is on the server for everyone.
  const kim = await works(KIM, "banks");
  assert.deepEqual(ids(kim), ["w-sam-ebook", "w-windward", "w-matter", "w-consensus-only", "w-wasp", "w-new", "w-removed"]);
  assert.ok(!ids(await works(KIM, "excession")).length);
  assert.ok(!ids(await works(KIM, "player games")).length, "a consensus text does not make a hidden placeholder visible");
  // The placeholder that is not Kim's lends Inversions no cover.
  assert.equal(kim.find((work) => work.workId === "w-sam-ebook")?.cover, "");
  // Visible to its owner (Sam has it in the library) and to the administrator.
  assert.deepEqual(ids(await works(SAM, "excession")), ["w-sam-shelf"]);
  assert.deepEqual(
    (await works(SAM, "excession"))[0],
    {
      workId: "w-sam-shelf",
      title: "Excession",
      author: "Iain M. Banks",
      year: 2000,
      cover: "https://assets.hardcover.app/hc-1002.jpg",
      inLibrary: true,
      hasAudiobook: false,
      hasEbook: false,
      hardcoverId: 1002,
    },
  );
  assert.deepEqual(ids(await works(OWNER, "excession")), ["w-sam-shelf"]);
  // Every result opens: the one-work read follows the same rule.
  assert.equal((await request(KIM, "/api/works/w-sam-ebook")).statusCode, 200);
  assert.equal((await request(KIM, "/api/works/w-sam-shelf")).statusCode, 404);
  assert.equal((await request(KIM, "/api/works/w-consensus")).statusCode, 404);
});

test("a consensus text is not counted as an ebook", async () => {
  const sam = await works(SAM, "banks");
  const of = (workId: string) => sam.find((work) => work.workId === workId)!;
  assert.deepEqual([of("w-consensus").hasEbook, of("w-consensus").hasAudiobook], [false, false]);
  assert.deepEqual([of("w-consensus-only").hasEbook, of("w-consensus-only").hasAudiobook], [false, false]);
  assert.deepEqual([of("w-sam-ebook").hasEbook, of("w-sam-ebook").hasAudiobook], [true, false]);
  assert.deepEqual([of("w-wasp").hasEbook, of("w-wasp").hasAudiobook], [false, true]);
  assert.ok(!ids(await works(SAM)).includes("w-consensus-only"), "a consensus text is not a file either");
});

test("the full shape of a result", async () => {
  assert.deepEqual(await works(OWNER, "matter"), [
    {
      workId: "w-matter",
      title: "Matter",
      author: "Iain M. Banks",
      year: 2008,
      cover: "/covers/ed-matter.jpg",
      inLibrary: true,
      hasAudiobook: true,
      hasEbook: false,
      hardcoverId: 1001,
    },
  ]);
});

test("at most 30 works answer, in title order with numbers in order", async () => {
  const list = await works(OWNER, "limit author");
  assert.equal(list.length, 30);
  assert.deepEqual(
    ids(list),
    Array.from({ length: 30 }, (_, index) => `w-limit-${index + 1}`),
  );
});

test("without a query: works not in the library, not removed, with a file, the newest first", async () => {
  // The owner's library (Matter, Look to Windward) and the removed Walking on Glass are left out, and
  // so are works without a file (Excession, The Player of Games, The Bridge, the Limit books).
  assert.deepEqual(ids(await works(OWNER)), ["w-new", "w-sam-ebook", "w-cafe", "w-wasp"]);
  // An empty or blank query is the same list.
  assert.deepEqual(ids(await works(OWNER, "")), ["w-new", "w-sam-ebook", "w-cafe", "w-wasp"]);
  assert.deepEqual(ids(await works(OWNER, "  ")), ["w-new", "w-sam-ebook", "w-cafe", "w-wasp"]);
  // Kim removed nothing and has nothing; Sam's placeholders stay hidden from Kim.
  assert.deepEqual(ids(await works(KIM)), ["w-new", "w-removed", "w-sam-ebook", "w-cafe", "w-wasp", "w-windward", "w-matter"]);
  // Sam's Inversions is in Sam's library; the owner's removal is not Sam's.
  assert.deepEqual(ids(await works(SAM)), ["w-new", "w-removed", "w-cafe", "w-wasp", "w-windward", "w-matter"]);
  assert.ok((await works(SAM)).every((work) => !work.inLibrary));
});

test("a query of one character or more than 150 is refused", async () => {
  assert.equal((await request(OWNER, "/api/works?q=a")).statusCode, 400);
  assert.equal((await request(OWNER, `/api/works?q=${"a".repeat(151)}`)).statusCode, 400);
  assert.equal((await request(OWNER, `/api/works?q=${"a".repeat(150)}`)).statusCode, 200);
});

test("Hardcover's hits name the work they open and whether it is on the server", async () => {
  for (const token of [OWNER, KIM])
    assert.equal((await request(token, "/api/hardcover/token", "PUT", { token: `hc-${token}` })).statusCode, 200);
  const search = async (token: string) => {
    const response = await request(token, "/api/discover/hardcover?q=matter%20banks");
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as {
      found: number;
      hits: { document: Record<string, unknown> & { id: string }; highlight: unknown; workId: string; onServer: boolean }[];
    };
  };
  const owner = await search(OWNER);
  // Matter is matched to w-matter; Consider Phlebas to nothing on the server; Excession to Sam's placeholder.
  assert.deepEqual(
    owner.hits.map((hit) => [hit.document.id, hit.workId, hit.onServer]),
    [
      ["1001", "w-matter", true],
      ["1002", "w-sam-shelf", true],
      ["1004", "work-hc-1004", false],
    ],
  );
  // Everything else of Hardcover's answer is as it was.
  assert.equal(owner.found, recordedSearch.found);
  assert.deepEqual(owner.hits[0].highlight, recordedSearch.hits[0].highlight);
  assert.deepEqual(
    { ...owner.hits[0].document },
    { ...recordedSearch.hits[0].document, url: "https://hardcover.app/books/matter" },
  );
  // Kim may not see Sam's placeholder: the hit names the work id the import would give it, not Sam's work.
  const kim = await search(KIM);
  assert.deepEqual(
    kim.hits.map((hit) => [hit.document.id, hit.workId, hit.onServer]),
    [
      ["1001", "w-matter", true],
      ["1002", "work-hc-1002", false],
      ["1004", "work-hc-1004", false],
    ],
  );
});

test("series search says which series the user saved", async () => {
  for (const token of [SAM, KIM])
    assert.equal((await request(token, "/api/hardcover/token", "PUT", { token: `hc-${token}` })).statusCode, 200);
  const series = async (token: string) => {
    const response = await request(token, "/api/discover/series?q=culture");
    assert.equal(response.statusCode, 200, response.body);
    return (response.json() as { id: number; saved: boolean }[]).map((entry) => [entry.id, entry.saved]);
  };
  assert.deepEqual(await series(SAM), [
    [5501, true],
    [5502, false],
  ]);
  assert.deepEqual(await series(KIM), [
    [5501, false],
    [5502, false],
  ], "Sam's saved series are not Kim's");
});
