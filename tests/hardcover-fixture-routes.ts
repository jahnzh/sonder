// Test-only stand-ins for two Hardcover routes removed in #721 part d (`PUT /api/hardcover/token` and
// `POST /api/hardcover/books`, which answer 410 now). The series code (part b) and Discover's Hardcover search
// (part c2) still read Hardcover's catalogue with the user's token until those parts move them to AudiobookDB;
// their tests give a user that token and import a Hardcover book through these routes instead. Never registered by
// the production server: only `tests/browser-server.ts` and the unit tests that need it call this. Removed in
// part b/c2 together with the code it serves.
import type { FastifyInstance } from "fastify";

export const HARDCOVER_TOKEN_FIXTURE = "/api/__fixture/hardcover-token";
export const HARDCOVER_BOOKS_FIXTURE = "/api/__fixture/hardcover-books";

export function registerHardcoverFixtureRoutes(app: FastifyInstance) {
  app.put(HARDCOVER_TOKEN_FIXTURE, async (req) => {
    const { currentUserId, setUserSecret } = await import("../server/users.ts");
    const { token } = (req.body ?? {}) as { token?: string };
    setUserSecret(currentUserId(req), "hardcover", String(token ?? ""));
    return { ok: true };
  });
  app.post(HARDCOVER_BOOKS_FIXTURE, async (req) => {
    const { currentUserId } = await import("../server/users.ts");
    const { importHardcoverBook } = await import("../server/hardcover.ts");
    const { id, workId } = (req.body ?? {}) as { id: number; workId?: string };
    return importHardcoverBook(currentUserId(req), Number(id), workId);
  });
}
