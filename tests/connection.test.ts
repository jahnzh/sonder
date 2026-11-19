// The shell's offline line (#581, spec #572 "The shell"): when there is no connection, and on which places and pages
// the line shows.
import test from "node:test";
import assert from "node:assert/strict";
import { connectionStore, isNoAnswer, offline, offlineLineShown, saysNoConnectionItself } from "../src/connection";
import { readAddress, type Route } from "../src/routes";
import { OFFLINE_LINE } from "../src/status-lines";

const route = (hash: string): Route => readAddress(hash);

test("there is no connection while the browser is offline or the last request got no answer", () => {
  assert.equal(offline({ browserOnline: true, reached: true }), false);
  assert.equal(offline({ browserOnline: false, reached: true }), true);
  assert.equal(offline({ browserOnline: true, reached: false }), true);
});

test("the store: a request with no answer shows the line, the next answered one takes it away", () => {
  const store = connectionStore(true);
  const seen: boolean[] = [];
  const stop = store.subscribe((state) => seen.push(offline(state)));
  store.answered();
  store.unanswered();
  store.unanswered();
  store.answered();
  store.browser(false);
  store.answered();
  assert.equal(offline(store.get()), true, "an answer does not override the browser saying it is offline");
  store.browser(true);
  stop();
  store.browser(false);
  // Only changes are told, and nothing after unsubscribing.
  assert.deepEqual(seen, [true, false, true, false]);
});

test("an aborted request is not a missing connection; any other failed fetch is", () => {
  const aborted = new Error("The operation was aborted.");
  aborted.name = "AbortError";
  assert.equal(isNoAnswer(aborted), false);
  assert.equal(isNoAnswer(new TypeError("Failed to fetch")), true);
  assert.equal(isNoAnswer(new TypeError("NetworkError when attempting to fetch resource.")), true);
});

test("the line shows on the places and pages that do not say No connection themselves", () => {
  const none = { browserOnline: false, reached: true };
  for (const hash of ["#library", "#discover", "#settings", "#settings/app", "#book/work-1", "#book/work-1/audiobook", "#book/work-1/hardcover"])
    assert.equal(offlineLineShown(none, route(hash)), true, hash);
  for (const hash of ["#activity", "#activity/device", "#activity/server", "#series/4", "#book/work-1/sync"])
    assert.equal(offlineLineShown(none, route(hash)), false, hash);
  assert.equal(offlineLineShown({ browserOnline: true, reached: true }, route("#library")), false, "gone with the connection back");
});

test("a worker's page is Activity's and says No connection itself", () => {
  assert.equal(saysNoConnectionItself({ name: "worker", worker: "wsl" }), true);
  assert.equal(saysNoConnectionItself({ name: "sync-details", workId: "work-1" }), true);
  assert.equal(saysNoConnectionItself({ name: "library" }), false);
});

test("the line's words", () => {
  assert.equal(`${OFFLINE_LINE.lead} · ${OFFLINE_LINE.rest}`, "No connection · Books on this device still play");
});
