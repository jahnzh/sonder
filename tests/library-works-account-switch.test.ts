// #528 review finding 1: a library works write (clear → bulkPut → tag) started for one account must go to that
// account's device database only, and must stop without writing once another account is signed in. The store
// is driven with an in-memory database whose transaction rolls back on a throw, as IndexedDB does, and the real
// `selectUserStorage` switches the account between the steps.
import { test } from "node:test";
import assert from "node:assert/strict";

const sessionStore = new Map<string, string>();
globalThis.window = { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), dispatchEvent: () => true } as any;
globalThis.location = { href: "http://localhost/", origin: "http://localhost", reload: () => {} } as any;
globalThis.sessionStorage = {
  getItem: (key: string) => sessionStore.get(key) ?? null,
  setItem: (key: string, value: string) => void sessionStore.set(key, value),
  removeItem: (key: string) => void sessionStore.delete(key),
} as any;

const { selectUserStorage, userId, replaceForAccount, AccountChanged } = await import("../src/lib.ts");
const { refreshLibraryWorks, setAccountStorageForTesting, storeLibraryWorks } = await import("../src/library-works-store.ts");

type Row = Record<string, unknown>;

/** One device database: tables of rows by key, and a transaction that restores them when its body throws. */
function memoryDatabase(name: string, hooks: { afterClear?: () => void; afterBulkPut?: () => void } = {}) {
  const data = { works: new Map<string, Row>(), preferences: new Map<string, Row>() };
  const ops: string[] = [];
  const table = (tableName: "works" | "preferences", key: string) => ({
    name: tableName,
    clear: async () => {
      ops.push(`${tableName}.clear`);
      data[tableName].clear();
      if (tableName === "works") hooks.afterClear?.();
    },
    bulkPut: async (rows: Row[]) => {
      ops.push(`${tableName}.bulkPut`);
      for (const row of rows) data[tableName].set(String(row[key]), row);
      if (tableName === "works") hooks.afterBulkPut?.();
    },
    get: async (id: string) => data[tableName].get(id),
    toArray: async () => [...data[tableName].values()],
    put: async (row: Row) => {
      ops.push(`${tableName}.put`);
      data[tableName].set(String(row[key]), row);
    },
    delete: async (id: string) => {
      ops.push(`${tableName}.delete`);
      data[tableName].delete(id);
    },
  });
  const db = {
    name,
    works: table("works", "workId"),
    preferences: table("preferences", "key"),
    transaction: async (_mode: string, _tables: unknown, body: () => Promise<void>) => {
      const saved = { works: new Map(data.works), preferences: new Map(data.preferences) };
      try {
        await body();
      } catch (error) {
        data.works = saved.works;
        data.preferences = saved.preferences;
        throw error;
      }
    },
  };
  return { db: db as any, data, ops };
}

const libraryOf = (user: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ workId: `work-${user}-${i}`, title: `Library of user ${user} #${i}` }) as any);

function seedOwner(data: ReturnType<typeof memoryDatabase>["data"]) {
  data.works.set("cached", { workId: "cached", title: "Owner's cached work" });
  data.preferences.set("library-works-tag", { key: "library-works-tag", value: '"old-tag"' });
}

test("a works write for the signed-in account replaces its works and tag", async () => {
  selectUserStorage(1);
  const owner = memoryDatabase("sonder");
  seedOwner(owner.data);
  assert.equal(await storeLibraryWorks(1, owner.db, libraryOf(1, 3), '"etag-1"'), true);
  assert.deepEqual([...owner.data.works.keys()], ["work-1-0", "work-1-1", "work-1-2"]);
  assert.equal(owner.data.preferences.get("library-works-tag")?.value, '"etag-1"');
});

test("an account switch after the clear rolls the write back and leaves the owner's works", async () => {
  selectUserStorage(1);
  const owner = memoryDatabase("sonder", { afterClear: () => selectUserStorage(2, "user") });
  const other = memoryDatabase("sonder-user-2");
  seedOwner(owner.data);
  assert.equal(await storeLibraryWorks(1, owner.db, libraryOf(1, 200), '"etag-1"'), false);
  assert.equal(userId(), 2);
  assert.deepEqual([...owner.data.works.keys()], ["cached"], "user 1's cached works survive");
  assert.equal(owner.data.preferences.get("library-works-tag")?.value, '"old-tag"', "user 1's tag is kept");
  assert.deepEqual(owner.ops, ["works.clear"], "nothing after the switch is written");
  assert.equal(other.data.works.size, 0);
  assert.deepEqual(other.ops, [], "user 2's database is never touched");
});

test("an account switch after the bulkPut rolls back before the tag is written", async () => {
  selectUserStorage(1);
  const owner = memoryDatabase("sonder", { afterBulkPut: () => selectUserStorage(2, "user") });
  seedOwner(owner.data);
  assert.equal(await storeLibraryWorks(1, owner.db, libraryOf(1, 5), '"etag-1"'), false);
  assert.deepEqual([...owner.data.works.keys()], ["cached"]);
  assert.equal(owner.data.preferences.get("library-works-tag")?.value, '"old-tag"');
  assert.deepEqual(owner.ops, ["works.clear", "works.bulkPut"]);
});

test("a write started for an account that is no longer signed in writes nothing", async () => {
  selectUserStorage(2, "user");
  const owner = memoryDatabase("sonder");
  seedOwner(owner.data);
  assert.equal(await storeLibraryWorks(1, owner.db, libraryOf(1, 5), '"etag-1"'), false);
  assert.deepEqual(owner.ops, []);
  assert.deepEqual([...owner.data.works.keys()], ["cached"]);
});

test("replaceForAccount passes through errors that are not an account switch", async () => {
  selectUserStorage(1);
  const owner = memoryDatabase("sonder");
  await assert.rejects(
    replaceForAccount(1, owner.db, [], async () => {
      throw new Error("QuotaExceededError");
    }),
    /QuotaExceededError/,
  );
  assert.ok(new AccountChanged() instanceof Error);
});

/** `refreshLibraryWorks` with in-memory databases per account and `GET /api/library` answering user 1's works. */
async function refreshWith(databases: Record<number, ReturnType<typeof memoryDatabase>>, onFetch?: () => void) {
  const works = libraryOf(1, 50);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    onFetch?.();
    return new Response(JSON.stringify(works), { status: 200, headers: { ETag: '"etag-1"' } });
  }) as typeof fetch;
  setAccountStorageForTesting(() => ({ owner: userId(), db: databases[userId()].db }));
  try {
    await refreshLibraryWorks();
  } finally {
    setAccountStorageForTesting();
    globalThis.fetch = nativeFetch;
  }
}

test("a library refresh writes the signed-in account's works into its own database", async () => {
  selectUserStorage(1);
  const owner = memoryDatabase("sonder");
  const other = memoryDatabase("sonder-user-2");
  seedOwner(owner.data);
  await refreshWith({ 1: owner, 2: other });
  assert.equal(owner.data.works.size, 50);
  assert.equal(owner.data.preferences.get("library-works-tag")?.value, '"etag-1"');
  assert.deepEqual(other.ops, []);
});

test("a library refresh with a sign-in as another account after its clear writes nothing anywhere", async () => {
  selectUserStorage(1);
  const owner = memoryDatabase("sonder", { afterClear: () => selectUserStorage(2, "user") });
  const other = memoryDatabase("sonder-user-2");
  seedOwner(owner.data);
  await refreshWith({ 1: owner, 2: other });
  assert.equal(userId(), 2);
  assert.deepEqual([...owner.data.works.keys()], ["cached"], "user 1's cached works survive");
  assert.equal(owner.data.preferences.get("library-works-tag")?.value, '"old-tag"');
  assert.deepEqual(other.ops, [], "user 2's database is never touched");
  assert.equal(other.data.works.size, 0);
});

test("a library refresh whose account changed during the read stops without writing", async () => {
  selectUserStorage(1);
  const owner = memoryDatabase("sonder");
  const other = memoryDatabase("sonder-user-2");
  seedOwner(owner.data);
  await refreshWith({ 1: owner, 2: other }, () => selectUserStorage(2, "user"));
  assert.deepEqual(owner.ops, []);
  assert.deepEqual(other.ops, []);
  assert.deepEqual([...owner.data.works.keys()], ["cached"]);
});
