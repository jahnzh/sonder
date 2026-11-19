// Test-only: the acquisition behind "Get this recording" on the Get sheet without a book (#576), for the browser
// suite's server. Never bundled into the production server.
//
// The suite's server has no TorBox and no torrent client, so `POST /api/discover/abb/add` cannot queue anything there.
// A spec answers the sheet's add with `POST /api/__fixture/new-book` instead: the server's own `acquireForNewBook`
// makes the work, its placeholder and the library row in the real database, and the acquisition is recorded as
// `acquire` records it before choosing a backend (`checking`, the requester's), where it stays: the download loop
// leaves a `checking` acquisition alone for a minute. `DELETE` removes that acquisition again. Nothing is fetched.
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

export async function installNewBookFixture(app: FastifyInstance) {
  const { db } = await import("../server/db.ts");
  const s = await import("../server/schema.ts");
  const { startAcquisitionRecord } = await import("../server/acquisition-status.ts");
  const { acquireForNewBook } = await import("../server/new-book.ts");
  type Metadata = { title?: string; author?: string; cover?: string; workId?: string; userId?: number };
  const record = async (magnet: string, metadata: Metadata = {}) => {
    const id = randomUUID();
    const hash = new URL(magnet).searchParams.get("xt")!.slice("urn:btih:".length);
    startAcquisitionRecord({
      id,
      hash,
      magnet,
      backend: "local",
      remoteId: null,
      title: metadata.title || "A new audiobook",
      author: metadata.author || "Unknown author",
      cover: metadata.cover?.startsWith("https://") ? metadata.cover : "/covers/time.svg",
      workId: metadata.workId || null,
      language: null,
      narrator: null,
      progress: 0,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    db.insert(s.userAcquisitions).values({ userId: metadata.userId ?? 1, acquisitionId: id }).onConflictDoNothing().run();
    return db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get()!;
  };
  app.post("/api/__fixture/new-book", async (request) => {
    const { title, author, cover } = request.body as { title: string; author?: string; cover?: string };
    const hash = randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);
    return acquireForNewBook(`magnet:?xt=urn:btih:${hash}`, { title, author, cover }, 1, record as never);
  });
  app.delete("/api/__fixture/new-book/:id", async (request) => {
    const { id } = request.params as { id: string };
    db.delete(s.userAcquisitions).where(eq(s.userAcquisitions.acquisitionId, id)).run();
    db.delete(s.acquisitions).where(eq(s.acquisitions.id, id)).run();
    return { ok: true };
  });
}
