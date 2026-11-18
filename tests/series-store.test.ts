// #568 (spec #560 "Without a connection"): the device keeps the last answer of `GET /api/series` and of each saved
// series opened, per account, and says when a read failed for want of a connection. Driven with an in-memory table
// (Node has no IndexedDB) in place of the per-user device database's `seriesAnswers` table.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), dispatchEvent: () => true } as any;
globalThis.location = { href: "http://localhost/", origin: "http://localhost", reload: () => {} } as any;

const { ApiError } = await import("../src/lib.ts");
const store = await import("../src/series-store.ts");

function memoryTable() {
  const rows = new Map<string, { key: string; value: unknown; storedAt: number }>();
  return {
    rows,
    table: {
      put: async (row: { key: string; value: unknown; storedAt: number }) => void rows.set(row.key, row),
      get: async (key: string) => rows.get(key),
      delete: async (key: string) => void rows.delete(key),
    },
  };
}

test("the last answer of the list and of a saved series is kept, read back and forgotten, per account", async () => {
  const first = memoryTable();
  const second = memoryTable();
  let signedIn = 1;
  store.setSeriesStorageForTesting(
    () => ({ owner: signedIn, db: { seriesAnswers: (signedIn === 1 ? first : second).table } as any }),
    () => signedIn,
  );
  try {
    assert.equal(await store.storedSeriesAnswer(store.SERIES_LIST_KEY), undefined);
    const list = [{ id: 701, name: "The Crossing", author: "Ada North", count: 3, finished: 1, total: 3, covers: [] }];
    await store.keepSeriesAnswer(store.SERIES_LIST_KEY, list);
    await store.keepSeriesAnswer(store.seriesAnswerKey(701), { id: 701, name: "The Crossing", works: [] });
    assert.deepEqual(await store.storedSeriesAnswer(store.SERIES_LIST_KEY), list);
    assert.deepEqual(await store.storedSeriesAnswer(store.seriesAnswerKey(701)), { id: 701, name: "The Crossing", works: [] });
    // A series never opened on this device has no answer.
    assert.equal(await store.storedSeriesAnswer(store.seriesAnswerKey(702)), undefined);
    // A newer answer replaces the older one.
    await store.keepSeriesAnswer(store.SERIES_LIST_KEY, []);
    assert.deepEqual(await store.storedSeriesAnswer(store.SERIES_LIST_KEY), []);

    // The second account's database holds none of the first account's answers.
    signedIn = 2;
    assert.equal(await store.storedSeriesAnswer(store.seriesAnswerKey(701)), undefined);
    assert.equal(second.rows.size, 0);

    // Removed (or not saved by this account): forgotten.
    signedIn = 1;
    await store.forgetSeriesAnswer(store.seriesAnswerKey(701));
    assert.equal(await store.storedSeriesAnswer(store.seriesAnswerKey(701)), undefined);
  } finally {
    store.setSeriesStorageForTesting();
  }
});

test("an answer read for one account is not given to another signed in during the read, nor written into it", async () => {
  const first = memoryTable();
  let signedIn = 1;
  first.rows.set("list", { key: "list", value: ["first account's"], storedAt: 1 });
  const slow = {
    ...first.table,
    get: async (key: string) => {
      signedIn = 2; // another account signs in while the device database is read
      return first.rows.get(key);
    },
  };
  store.setSeriesStorageForTesting(() => ({ owner: 1, db: { seriesAnswers: slow } as any }), () => signedIn);
  try {
    assert.equal(await store.storedSeriesAnswer(store.SERIES_LIST_KEY), undefined);
    // Written while another account is signed in: the first account's database is left alone.
    await store.keepSeriesAnswer(store.SERIES_LIST_KEY, ["late"]);
    assert.deepEqual(first.rows.get("list")?.value, ["first account's"]);
  } finally {
    store.setSeriesStorageForTesting();
  }
});

test("no connection: the browser is offline or the request got no answer; a refusal of the server is an answer", () => {
  assert.equal(store.isNoConnection(new TypeError("Failed to fetch"), true), true);
  assert.equal(store.isNoConnection(new TypeError("NetworkError when attempting to fetch resource."), true), true);
  assert.equal(store.isNoConnection(new Error("anything"), false), true);
  assert.equal(store.isNoConnection(new ApiError("Series could not be found.", 404), true), false);
  assert.equal(store.isNoConnection(new ApiError("Hardcover is down", 502), false), false);
  assert.equal(store.isNoConnection(new Error("Account changed in another tab."), true), false);
});
