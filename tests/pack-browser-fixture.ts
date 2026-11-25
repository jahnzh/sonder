// A test-only route (never registered by the production server) for the series pack spec (ADR 0027, #899):
// `POST /api/__fixture/series-pack` with `{ action: "setup" }` writes a saved series of three books that are not on
// AudiobookDB ("Pack Fixture Saga": Lantern Road, Ember Gate, Cinder Bell), each in the library without audio, and a
// TorBox pack that holds Cinder Bell but whose files the split could not tell ("Disc A", "Disc B"): it waits for the
// owner's choice. `{ action: "teardown" }` takes the series and the books' library rows away again, so no other spec
// sees them. A setup after a run that chose the files makes the pack wait again.
import type { FastifyInstance } from "fastify";

export const PACK_FIXTURE = "/api/__fixture/series-pack";
export const PACK_SERIES = { id: "pack-fixture-saga", name: "Pack Fixture Saga" };
export const PACK_BOOKS = [
  { workId: "work-pack-lantern", title: "Lantern Road" },
  { workId: "work-pack-ember", title: "Ember Gate" },
  { workId: "work-pack-cinder", title: "Cinder Bell" },
];
export const PACK_ACQUISITION = "acq-pack-fixture";
const PACK_HASH = "f0".repeat(20);

export function registerPackFixtureRoutes(app: FastifyInstance) {
  app.post(PACK_FIXTURE, async (req) => {
    const { currentUserId } = await import("../server/users.ts");
    const { sqlite } = await import("../server/db.ts");
    const { ensurePlaceholder } = await import("../server/placeholder-edition.ts");
    const userId = currentUserId(req);
    const { action } = (req.body ?? {}) as { action?: string };
    const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    const editionsOf = (workId: string) =>
      (sqlite.prepare("SELECT id FROM audio_editions WHERE work_id=?").all(workId) as { id: string }[]).map((row) => row.id);
    sqlite.transaction(() => {
      run("DELETE FROM user_saved_series_works WHERE series_id=?", PACK_SERIES.id);
      run("DELETE FROM user_saved_series WHERE series_id=?", PACK_SERIES.id);
      run("DELETE FROM series_catalogue_works WHERE series_id=?", PACK_SERIES.id);
      run("DELETE FROM series_catalogue WHERE id=?", PACK_SERIES.id);
      // The recording a chosen pack made, so the pack waits again.
      for (const row of sqlite.prepare("SELECT book_id AS bookId FROM acquisition_works WHERE acquisition_id=? AND book_id IS NOT NULL").all(PACK_ACQUISITION) as { bookId: string }[]) {
        run("DELETE FROM user_library WHERE book_id=?", row.bookId);
        run("DELETE FROM user_hidden_library WHERE book_id=?", row.bookId);
        run("DELETE FROM tracks WHERE recording_id=?", `recording-${row.bookId}`);
        run("DELETE FROM recordings WHERE id=?", `recording-${row.bookId}`);
        run("DELETE FROM audio_editions WHERE id=?", row.bookId);
      }
      run("UPDATE acquisition_works SET status='choose',book_id=NULL,files=NULL WHERE acquisition_id=?", PACK_ACQUISITION);
      for (const book of PACK_BOOKS)
        for (const id of editionsOf(book.workId)) {
          run("DELETE FROM user_library WHERE book_id=?", id);
          run("DELETE FROM user_hidden_library WHERE book_id=?", id);
        }
      if (action !== "setup") return;
      run("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(?,?,'Ada North',3)", PACK_SERIES.id, PACK_SERIES.name);
      run("INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(?,?,?)", userId, PACK_SERIES.id, Date.now());
      PACK_BOOKS.forEach((book, index) => {
        run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'Ada North','','Fantasy',2024) ON CONFLICT DO NOTHING", book.workId, book.title);
        run(
          "INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,unreleased,language) VALUES(?,?,?,?,?,0,'English')",
          PACK_SERIES.id, `${book.workId}-bk`, book.workId, book.title, index + 1,
        );
        run("INSERT INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(?,?,?,?,1)", userId, PACK_SERIES.id, `${book.workId}-bk`, book.workId);
        run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?) ON CONFLICT DO NOTHING", userId, ensurePlaceholder(sqlite, book.workId), Date.now());
      });
      const cinder = PACK_BOOKS[2];
      run(
        `INSERT INTO acquisitions(id,hash,magnet,backend,remote_id,title,author,cover,status,progress,error,book_id,work_id,created_at,updated_at)
         VALUES(?,?,?,'torbox','777','Pack Fixture Saga Collection','Ada North','','ready',1,NULL,NULL,?,?,?) ON CONFLICT DO NOTHING`,
        PACK_ACQUISITION, PACK_HASH, `magnet:?xt=urn:btih:${PACK_HASH}`, cinder.workId, Date.now(), Date.now(),
      );
      run("INSERT INTO user_acquisitions(user_id,acquisition_id) VALUES(?,?) ON CONFLICT DO NOTHING", userId, PACK_ACQUISITION);
      run(
        "INSERT INTO acquisition_packs(acquisition_id,series_id,series_name,volumes,files,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        PACK_ACQUISITION, PACK_SERIES.id, PACK_SERIES.name,
        JSON.stringify(PACK_BOOKS.map((book, index) => ({ position: index + 1, title: book.title }))),
        JSON.stringify([
          { key: "1", name: "Saga/Disc A/01.m4b" },
          { key: "2", name: "Saga/Disc A/02.m4b" },
          { key: "3", name: "Saga/Disc B/01.m4b" },
        ]),
        Date.now(),
      );
      run(
        "INSERT INTO acquisition_works(acquisition_id,work_id,position,title,status,updated_at) VALUES(?,?,3,?,'choose',?) ON CONFLICT DO NOTHING",
        PACK_ACQUISITION, cinder.workId, cinder.title, Date.now(),
      );
    })();
    return { ok: true };
  });
}
