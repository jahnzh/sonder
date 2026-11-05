import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { magnetHash } from "../server/acquisitions.ts";
import { db } from "../server/db.ts";
import * as schema from "../server/schema.ts";
import { setSeriesReleaseSearchDeps } from "../server/series-release-search.ts";

const crossingTwoListing = `<div class="post"><div class="postTitle"><h2><a href="/abss/crossing-two-fixture/">Crossing Two - Ada North</a></h2></div><div class="postInfo">Language: English</div><div class="postContent">Format: M4B / Bitrate: 64 Kbps<br>File Size: 400 MBs</div></div>`;
const crossingTwoDetail = `<div class="post"><div class="postTitle"><h1>Crossing Two</h1></div><div class="postContent"><span class="narrator">Fixture Narrator</span><a href="magnet:?xt=urn:btih:${"d".repeat(40)}">Magnet</a></div></div>`;
const crossingAltListing = `<div class="post"><div class="postTitle"><h2><a href="/abss/crossing-two-alt/">Crossing Two Alt</a></h2></div><div class="postContent">Format: MP3<br>File Size: 300 MBs</div></div>`;
const crossingAltDetail = `<div class="post"><div class="postContent"><a href="magnet:?xt=urn:btih:${"e".repeat(40)}">Magnet</a></div></div>`;

export function installSeriesReleaseBrowserFixture() {
  setSeriesReleaseSearchDeps({
    acquire: async (magnet, metadata) => {
      const hash = magnetHash(magnet);
      const existing = db
        .select()
        .from(schema.acquisitions)
        .where(eq(schema.acquisitions.hash, hash))
        .get();
      const id = existing?.id ?? randomUUID();
      const row = {
        id,
        hash,
        magnet,
        backend: "local" as const,
        remoteId: null,
        title: metadata?.title ?? "Crossing Two",
        author: metadata?.author ?? "Ada North",
        cover: metadata?.cover ?? "",
        workId: metadata?.workId ?? null,
        language: metadata?.language ?? null,
        narrator: metadata?.narrator ?? null,
        status: "checking" as const,
        progress: 0,
        error: null,
        bookId: null,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      db.insert(schema.acquisitions)
        .values(row)
        .onConflictDoUpdate({
          target: schema.acquisitions.hash,
          set: {
            title: row.title,
            author: row.author,
            workId: row.workId,
            updatedAt: row.updatedAt,
          },
        })
        .run();
      db.insert(schema.userAcquisitions)
        .values({
          userId: metadata?.userId ?? 1,
          acquisitionId: id,
        })
        .onConflictDoNothing()
        .run();
      return db
        .select()
        .from(schema.acquisitions)
        .where(eq(schema.acquisitions.id, id))
        .get()!;
    },
  });

  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith("audiobookbay.")) {
      if (url.pathname.includes("crossing-two-alt"))
        return new Response(crossingAltDetail);
      if (url.pathname.includes("crossing-two-fixture"))
        return new Response(crossingTwoDetail);
      if (url.pathname.includes("/page/") || url.searchParams.get("s"))
        return new Response(crossingTwoListing + crossingAltListing);
    }
    return original(input, init);
  };
}
