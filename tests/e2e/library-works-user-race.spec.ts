// @projects firefox
// Review #528, finding 1: a library write started for one account while the user signs in as another must stay
// in the first account's device database. The page runs the real client modules (`src/library-works-store.ts`
// and `src/lib.ts`, bundled here with esbuild) against real IndexedDB; the account switch is made with the real
// `selectUserStorage` right after the write's clear, which is where the `localDB` proxy used to send the rest of
// the write (bulkPut, tag) into the other account's database. Each run uses its own origin and its own titles,
// so the spec can run twice on one server.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { test, expect, type Browser } from "@playwright/test";

const srcDir = fileURLToPath(new URL("../../src/", import.meta.url));

async function bundle() {
  const result = await build({
    stdin: {
      contents: `
        import Dexie from "dexie";
        import { accountDatabase, loadBooks, localDB, selectUserStorage, SonderDB, userId } from "./lib";
        import { refreshLibraryWorks, useStoredWorks } from "./library-works-store";
        void useStoredWorks;
        window.__sonder = { Dexie, SonderDB, accountDatabase, loadBooks, localDB, refreshLibraryWorks, selectUserStorage, userId };
      `,
      resolveDir: srcDir,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/** A page origin of its own that serves the bundle, `/api/library` and `/api/books` for user 1. */
async function withPage(browser: Browser, run: string, use: (page: import("@playwright/test").Page) => Promise<void>) {
  const script = await bundle();
  const works = Array.from({ length: 300 }, (_, i) => ({
    workId: `work-${run}-${i}`,
    title: `From user 1 ${run} #${i}`,
    recordings: [{ recordingId: `rec-${run}-${i}`, tracks: Array.from({ length: 12 }, (_, t) => ({ id: `t-${t}`, duration: 60 })) }],
    ebookEditions: [],
  }));
  const books = works.map((work) => ({ id: `book-${work.workId}`, title: work.title, recordingId: work.recordings[0].recordingId }));
  const server = createServer((req, res) => {
    if (req.url === "/bundle.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(script);
    } else if (req.url === "/api/library") {
      res.writeHead(200, { "content-type": "application/json", etag: `"etag-user-1-${run}"` });
      res.end(JSON.stringify(works));
    } else if (req.url === "/api/books") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(books));
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><body>ok<script src="/bundle.js"></script></body>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await page.waitForFunction(() => "__sonder" in window);
    await use(page);
  } finally {
    await page.close();
    server.close();
  }
}

test("a library works write started for one user must not clear their store or fill another's", async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  await withPage(browser, run, async (page) => {
    const result = await page.evaluate(async (run) => {
      const s = (window as any).__sonder;
      await s.Dexie.delete("sonder");
      await s.Dexie.delete("sonder-user-2");
      s.selectUserStorage(1);
      await s.localDB.works.put({ workId: `cached-${run}`, title: `Owner's cached work ${run}` });
      await s.localDB.preferences.put({ key: "library-works-tag", value: '"old-tag"' });
      // The user signs in as the second account just after the write has cleared user 1's works.
      const table = s.accountDatabase().db.works;
      const clear = table.clear.bind(table);
      let switched = false;
      table.clear = () =>
        clear().then((value: unknown) => {
          if (!switched) s.selectUserStorage(2, "user");
          switched = true;
          return value;
        });
      let writeError: string | null = null;
      await s.refreshLibraryWorks().catch((error: unknown) => (writeError = String(error)));
      delete table.clear;

      const owner = new s.SonderDB("sonder");
      const other = new s.SonderDB("sonder-user-2");
      await owner.open();
      await other.open();
      const otherWorks = await other.table("works").toArray();
      const otherTag = (await other.table("preferences").get("library-works-tag"))?.value ?? null;
      const out = {
        switched,
        signedIn: s.userId(),
        writeError,
        ownerCount: await owner.table("works").count(),
        ownerStillHasCached: !!(await owner.table("works").get(`cached-${run}`)),
        ownerTag: (await owner.table("preferences").get("library-works-tag"))?.value ?? null,
        otherCount: otherWorks.length,
        otherHasUser1Title: otherWorks.some((row: any) => String(row.title).startsWith("From user 1")),
        otherTag,
      };
      owner.close();
      other.close();
      return out;
    }, run);

    expect(result.switched, JSON.stringify(result)).toBe(true);
    expect(result.signedIn).toBe(2);
    expect(result.writeError, JSON.stringify(result)).toBeNull();
    // Privacy: nothing of user 1's write reaches user 2's database.
    expect(result.otherHasUser1Title, `user 2 received user 1's works: ${JSON.stringify(result)}`).toBe(false);
    expect(result.otherCount, `user 2 works count: ${JSON.stringify(result)}`).toBe(0);
    expect(result.otherTag, `user 2 received user 1's entity tag: ${JSON.stringify(result)}`).toBeNull();
    // Durability: the stopped write is rolled back, so user 1 keeps the works and tag they had.
    expect(result.ownerStillHasCached, `user 1's works table was emptied by a crossed write: ${JSON.stringify(result)}`).toBe(true);
    expect(result.ownerCount).toBe(1);
    expect(result.ownerTag).toBe('"old-tag"');
  });
});

test("a books write started for one user must not clear their store or fill another's", async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  await withPage(browser, run, async (page) => {
    const result = await page.evaluate(async (run) => {
      const s = (window as any).__sonder;
      await s.Dexie.delete("sonder");
      await s.Dexie.delete("sonder-user-2");
      s.selectUserStorage(1);
      await s.localDB.books.put({ id: `cached-${run}`, title: `Owner's cached book ${run}`, recordingId: `rec-cached-${run}` });
      const table = s.accountDatabase().db.books;
      const clear = table.clear.bind(table);
      let switched = false;
      table.clear = () =>
        clear().then((value: unknown) => {
          if (!switched) s.selectUserStorage(2, "user");
          switched = true;
          return value;
        });
      let loadError: string | null = null;
      const loaded = await s.loadBooks().catch((error: unknown) => ((loadError = String(error)), []));
      delete table.clear;

      const owner = new s.SonderDB("sonder");
      const other = new s.SonderDB("sonder-user-2");
      await owner.open();
      await other.open();
      const otherBooks = await other.table("books").toArray();
      const out = {
        switched,
        loadError,
        loadedCount: loaded.length,
        ownerCount: await owner.table("books").count(),
        ownerStillHasCached: !!(await owner.table("books").get(`cached-${run}`)),
        otherCount: otherBooks.length,
      };
      owner.close();
      other.close();
      return out;
    }, run);

    expect(result.switched, JSON.stringify(result)).toBe(true);
    expect(result.loadError, JSON.stringify(result)).toBeNull();
    expect(result.otherCount, `user 2 received user 1's books: ${JSON.stringify(result)}`).toBe(0);
    expect(result.ownerStillHasCached, `user 1's books were emptied by a crossed write: ${JSON.stringify(result)}`).toBe(true);
    expect(result.ownerCount).toBe(1);
    // The caller that asked for user 1's books still gets what the server answered for user 1.
    expect(result.loadedCount).toBe(300);
  });
});
