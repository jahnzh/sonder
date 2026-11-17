// Review #528: prove that loadOnce's write (src/library-works-store.ts) through the personalDB proxy
// (src/lib.ts) can land one user's library works in another's IndexedDB when selectUserStorage flips
// mid-write. Same shape as the production write: transaction → clear → bulkPut → tag. A macrotask
// (login) during a large bulkPut is enough; the owner's library is large enough for that on a phone.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";

const dexieSrc = readFileSync(new URL("../../node_modules/dexie/dist/dexie.min.js", import.meta.url), "utf8");

test("a library works write started for one user must not clear their store or fill another's", async ({ browser }) => {
  const server = createServer((req, res) => {
    if (req.url === "/dexie.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(dexieSrc);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<script src="/dexie.js"></script><body>ok</body>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    const result = await page.evaluate(async () => {
      const Dexie = (window as unknown as { Dexie: typeof import("dexie").default }).Dexie;
      class SonderDB extends Dexie {
        works!: import("dexie").Table<{ workId: string; title: string }, string>;
        preferences!: import("dexie").Table<{ key: string; value: unknown }, string>;
        constructor(name: string) {
          super(name);
          this.version(1).stores({ works: "workId", preferences: "key" });
        }
      }
      await Dexie.delete("sonder");
      await Dexie.delete("sonder-user-2");
      // Same idea as src/lib.ts: personalDB flips on selectUserStorage; localDB reads it each time.
      let personalDB: SonderDB = new SonderDB("sonder");
      await personalDB.open();
      await personalDB.works.put({ workId: "already-a", title: "Owner's cached work" });
      await personalDB.preferences.put({ key: "library-works-tag", value: '"old-tag"' });
      await new SonderDB("sonder-user-2").open().then((db) => db.close());

      const localDB = new Proxy({} as SonderDB, {
        get(_, prop) {
          const db = personalDB;
          if (prop === "transaction") {
            return (...args: unknown[]) => {
              const table = args[1] as { db?: SonderDB };
              return (table?.db || db).transaction.apply(table?.db || db, args as never);
            };
          }
          const value = Reflect.get(db, prop, db);
          return typeof value === "function" ? value.bind(db) : value;
        },
      });

      // A macrotask login mid-write, as sonder:unauthorized → Sign in for user 2 would be.
      const login = setInterval(() => {
        if (personalDB.name === "sonder") personalDB = new SonderDB("sonder-user-2");
      }, 0);

      let writeError: string | null = null;
      try {
        // Same write as loadOnce in src/library-works-store.ts (lines 108–113).
        const works = Array.from({ length: 200 }, (_, i) => ({
          workId: `work-${i}`,
          title: `From user 1 #${i}`,
          recordings: [{ recordingId: `rec-${i}`, tracks: Array.from({ length: 12 }, (__, t) => ({ id: `t-${t}`, duration: 60 })) }],
        }));
        await localDB.transaction("rw", localDB.works, localDB.preferences, async () => {
          await localDB.works.clear();
          await localDB.works.bulkPut(works);
          await localDB.preferences.put({ key: "library-works-tag", value: '"etag-user-1"' });
        });
      } catch (error) {
        writeError = String(error);
      }
      clearInterval(login);

      const owner = new SonderDB("sonder");
      const other = new SonderDB("sonder-user-2");
      await owner.open();
      await other.open();
      const out = {
        writeError,
        ownerCount: await owner.works.count(),
        ownerStillHasCached: !!(await owner.works.get("already-a")),
        ownerTag: (await owner.preferences.get("library-works-tag"))?.value ?? null,
        otherCount: await other.works.count(),
        otherHasUser1Title: (await other.works.toArray()).some((row) => String(row.title).startsWith("From user 1")),
        otherTag: (await other.preferences.get("library-works-tag"))?.value ?? null,
      };
      owner.close();
      other.close();
      await Dexie.delete("sonder");
      await Dexie.delete("sonder-user-2");
      return out;
    });

    // Privacy / durability invariant for #528's works write: a write that began as user 1 must not
    // put user 1's library into user 2's database, and must not leave user 1 with an empty works
    // table after a failed cross-user write.
    expect(result.otherHasUser1Title, `user 2 received user 1's works: ${JSON.stringify(result)}`).toBe(false);
    expect(result.otherCount, `user 2 works count: ${JSON.stringify(result)}`).toBe(0);
    expect(
      result.ownerCount > 0,
      `user 1's works table was emptied by a crossed write: ${JSON.stringify(result)}`,
    ).toBe(true);
  } finally {
    await page.close();
    server.close();
  }
});
