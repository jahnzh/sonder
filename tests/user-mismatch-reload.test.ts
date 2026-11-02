import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal browser stubs required by src/lib.ts module top-level and fetch wrapper
let mockNativeFetch: (input: any, init?: any) => Promise<any> = async () => ({
  status: 200,
  ok: true,
  json: async () => ({}),
});

let reloadedCount = 0;

const windowStub = {
  fetch: (input: any, init?: any) => mockNativeFetch(input, init),
  dispatchEvent: () => {},
};

const locationStub = {
  href: "http://localhost:3001/",
  origin: "http://localhost:3001",
  reload: () => {
    reloadedCount++;
  },
};

const sessionStorageStub = {
  store: new Map<string, string>(),
  getItem: (key: string) => sessionStorageStub.store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    sessionStorageStub.store.set(key, value);
  },
  removeItem: (key: string) => {
    sessionStorageStub.store.delete(key);
  },
  clear: () => {
    sessionStorageStub.store.clear();
  },
};

globalThis.window = windowStub as any;
globalThis.location = locationStub as any;
globalThis.sessionStorage = sessionStorageStub as any;

const {
  mismatchShouldReload,
  resolveUserMismatch,
  resetMismatchForTesting,
  selectUserStorage,
} = await import("../src/lib.ts");

test("mismatchShouldReload returns false when session user id matches currentUserId", () => {
  assert.equal(mismatchShouldReload({ id: 1 }, 1), false);
  assert.equal(mismatchShouldReload({ id: 2 }, 2), false);
  assert.equal(mismatchShouldReload({ id: 100 }, 100), false);
});

test("mismatchShouldReload returns true when session user differs, is null, or is missing", () => {
  assert.equal(mismatchShouldReload({ id: 2 }, 1), true);
  assert.equal(mismatchShouldReload({ id: 1 }, 2), true);
  assert.equal(mismatchShouldReload(null, 1), true);
  assert.equal(mismatchShouldReload(undefined, 1), true);
  assert.equal(mismatchShouldReload({}, 1), true);
});

test("status matches -> no reload", async () => {
  resetMismatchForTesting();
  let reloaded = false;
  const reload = () => {
    reloaded = true;
  };
  const fetchStatus = async () => ({
    ok: true,
    json: async () => ({
      required: true,
      authenticated: true,
      user: { id: 1, username: "admin", role: "admin" },
    }),
  } as any);

  const result = await resolveUserMismatch(fetchStatus, reload, 1);
  assert.equal(result, false);
  assert.equal(reloaded, false);
});

test("status user differs -> reload", async () => {
  resetMismatchForTesting();
  let reloaded = false;
  const reload = () => {
    reloaded = true;
  };
  const fetchStatus = async () => ({
    ok: true,
    json: async () => ({
      required: true,
      authenticated: true,
      user: { id: 2, username: "reader", role: "user" },
    }),
  } as any);

  const result = await resolveUserMismatch(fetchStatus, reload, 1);
  assert.equal(result, true);
  assert.equal(reloaded, true);
});

test("status fetch rejected -> reload", async () => {
  // Rejection due to network failure
  resetMismatchForTesting();
  let reloaded = false;
  const reload = () => {
    reloaded = true;
  };
  const fetchRejecting = async () => {
    throw new Error("Network offline");
  };

  const resultReject = await resolveUserMismatch(fetchRejecting, reload, 1);
  assert.equal(resultReject, true);
  assert.equal(reloaded, true);

  // Status response with HTTP error (e.g. 500)
  resetMismatchForTesting();
  reloaded = false;
  const fetchHttp500 = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: "Server error" }),
  } as any);

  const resultHttpError = await resolveUserMismatch(fetchHttp500, reload, 1);
  assert.equal(resultHttpError, true);
  assert.equal(reloaded, true);
});

test("singleton: a second concurrent mismatch is not re-decided", async () => {
  resetMismatchForTesting();
  let fetchCalls = 0;
  let reloadedTimes = 0;
  let resolvePendingFetch: (val: any) => void;
  const pendingPromise = new Promise<{ ok: boolean; json: () => Promise<any> }>((resolve) => {
    resolvePendingFetch = resolve;
  });

  const fetchStatus = async () => {
    fetchCalls++;
    return pendingPromise;
  };
  const reload = () => {
    reloadedTimes++;
  };

  // Launch first mismatch resolution
  const first = resolveUserMismatch(fetchStatus, reload, 1);
  assert.equal(fetchCalls, 1);

  // Second concurrent mismatch resolution should be skipped
  const second = await resolveUserMismatch(fetchStatus, reload, 1);
  assert.equal(second, undefined);
  assert.equal(fetchCalls, 1);

  // Third concurrent mismatch resolution should also be skipped
  const third = await resolveUserMismatch(fetchStatus, reload, 1);
  assert.equal(third, undefined);
  assert.equal(fetchCalls, 1);

  // Resolve pending fetch with a user mismatch (which triggers reload)
  resolvePendingFetch!({
    ok: true,
    json: async () => ({
      required: true,
      authenticated: true,
      user: { id: 2, username: "reader", role: "user" },
    }),
  });

  const firstResult = await first;
  assert.equal(firstResult, true);
  assert.equal(fetchCalls, 1);
  assert.equal(reloadedTimes, 1);
});

test("window.fetch throws 409 user_mismatch and skips reload when session already matches", async () => {
  resetMismatchForTesting();
  reloadedCount = 0;
  selectUserStorage(1, "admin");

  mockNativeFetch = async (input: any) => {
    const url = input.toString();
    if (url.includes("/api/auth/status")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          required: false,
          authenticated: true,
          user: { id: 1, username: "admin", role: "admin" },
        }),
      };
    }
    return {
      status: 409,
      ok: false,
      clone: () => ({
        json: async () => ({ code: "user_mismatch", error: "Signed in as a different user." }),
      }),
    };
  };

  await assert.rejects(
    async () => {
      await window.fetch("http://localhost:3001/api/queue");
    },
    { message: "Account changed in another tab." },
  );

  // Allow microtasks to settle
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reloadedCount, 0, "should not reload when session already matches current user");
});

test("window.fetch throws 409 user_mismatch and reloads when session user differs", async () => {
  resetMismatchForTesting();
  reloadedCount = 0;
  selectUserStorage(1, "admin");

  mockNativeFetch = async (input: any) => {
    const url = input.toString();
    if (url.includes("/api/auth/status")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          required: false,
          authenticated: true,
          user: { id: 2, username: "reader", role: "user" },
        }),
      };
    }
    return {
      status: 409,
      ok: false,
      clone: () => ({
        json: async () => ({ code: "user_mismatch", error: "Signed in as a different user." }),
      }),
    };
  };

  await assert.rejects(
    async () => {
      await window.fetch("http://localhost:3001/api/queue");
    },
    { message: "Account changed in another tab." },
  );

  // Allow microtasks to settle
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reloadedCount, 1, "should reload when session user differs from current user");
});
