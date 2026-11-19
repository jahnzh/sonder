// A test-only route (never registered by the production server): a book in the signed-in user's library, made the
// way an older import left one, for the specs that need a work on the server before a series or Discover lists it
// (#721: in place of the Hardcover import those specs used). The work has the title and author it is given, no
// catalogue link and no audio; it joins the library through its placeholder (`addWorkToLibrary`). A second call with
// the same title and author adds the same work again.
import type { FastifyInstance } from "fastify";

export const LIBRARY_BOOK_FIXTURE = "/api/__fixture/library-book";

export function registerLibraryFixtureRoutes(app: FastifyInstance) {
  app.post(LIBRARY_BOOK_FIXTURE, async (req) => {
    const { currentUserId } = await import("../server/users.ts");
    const { sqlite } = await import("../server/db.ts");
    const { addWorkToLibrary } = await import("../server/work-library.ts");
    const { title, author } = (req.body ?? {}) as { title: string; author: string };
    const workId = `work-fixture-${title}-${author}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,'','',0) ON CONFLICT DO NOTHING").run(workId, title, author);
    addWorkToLibrary(currentUserId(req), workId);
    return { ok: true, workId };
  });
}
