// The prepared text a kept book keeps on this device (#805): which pictures a part shows, when a kept record is whole
// for its manifest, when a server's answer makes it stale, which cached addresses are an edition's and which belong to
// an output it replaced; and that the service worker and Reset this device agree with the cache's name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KEPT_TEXT_CACHE,
  belongsToEdition,
  keptTextMatches,
  noticeAnswer,
  partAddress,
  pictureAddress,
  pictureNames,
  preparedAddress,
  preparedBase,
  replacedOutput,
} from "../src/keep-text.ts";

const KEY = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const base = preparedBase("ed 1", KEY);

test("addresses: the manifest, a part and a picture of an output, as the server serves them", () => {
  assert.equal(preparedAddress("ed 1"), "/api/reader/ed%201/prepared");
  assert.equal(base, `/api/reader/ed%201/prepared/${KEY}`);
  assert.equal(partAddress(base, 3), `/api/reader/ed%201/prepared/${KEY}/parts/3`);
  assert.equal(pictureAddress(base, "0.jpg"), `/api/reader/ed%201/prepared/${KEY}/pictures/0.jpg`);
});

test("pictures: a part's own pictures by name, once each, in order; nothing outside the output", () => {
  const html =
    `<section data-section="0"><p><img src="${base}/pictures/1.png" alt=""></p>` +
    `<p><img alt="x" src="${base}/pictures/0.jpg"></p><img src="${base}/pictures/1.png">` +
    // Another output's, another book's, an outside address, a name the server never writes: none is kept.
    `<img src="${preparedBase("ed 1", OTHER)}/pictures/2.png"><img src="${preparedBase("ed 2", KEY)}/pictures/3.png">` +
    `<img src="https://example.com/4.png"><img src="${base}/pictures/../manifest.json"><img src="${base}/pictures/x.exe">` +
    `<a data-src="${base}/pictures/5.png">a link that is no picture</a></section>`;
  assert.deepEqual(pictureNames(html, base), ["1.png", "0.jpg"]);
  assert.deepEqual(pictureNames("<p>No pictures.</p>", base), []);
});

test("whole: a kept record reads only with the manifest it names", () => {
  const manifest = { key: KEY, fingerprint: "fp", parts: [{}, {}, {}] } as never;
  const record = { key: KEY, fingerprint: "fp", parts: 3 };
  assert.equal(keptTextMatches(record, manifest), true);
  assert.equal(keptTextMatches({ ...record, key: OTHER }, manifest), false);
  assert.equal(keptTextMatches({ ...record, fingerprint: "other" }, manifest), false);
  assert.equal(keptTextMatches({ ...record, parts: 2 }, manifest), false);
  assert.equal(keptTextMatches(null, manifest), false);
});

test("stale: a server's manifest of another output or another file marks the kept text stale, once", () => {
  const record = { key: KEY, fingerprint: "fp" };
  assert.equal(noticeAnswer(record, { key: KEY, fingerprint: "fp" }), null);
  // Prepared anew (new preparing code, another Node), or the book's file was replaced.
  assert.equal(noticeAnswer(record, { key: OTHER, fingerprint: "fp" }), "stale");
  assert.equal(noticeAnswer(record, { key: KEY, fingerprint: "fp-new" }), "stale");
  // Already stale, or nothing kept: nothing to write.
  assert.equal(noticeAnswer({ ...record, stale: true }, { key: OTHER, fingerprint: "fp" }), null);
  assert.equal(noticeAnswer(null, { key: OTHER, fingerprint: "fp" }), null);
});

test("removal: an edition's addresses, every output of it; a replaced output's, not the current one's", () => {
  assert.equal(belongsToEdition("/api/reader/ed%201/prepared", "ed 1"), true);
  assert.equal(belongsToEdition(`/api/reader/ed%201/prepared/${KEY}/parts/0`, "ed 1"), true);
  assert.equal(belongsToEdition(`/api/reader/ed%201/prepared/${OTHER}/pictures/0.jpg`, "ed 1"), true);
  // Another edition whose id starts the same is not this one's.
  assert.equal(belongsToEdition(`/api/reader/ed%2010/prepared/${KEY}/parts/0`, "ed 1"), false);
  assert.equal(belongsToEdition("/api/reader/ed%201/prepared-refused", "ed 1"), false);
  assert.equal(replacedOutput(`/api/reader/ed%201/prepared/${OTHER}/parts/0`, "ed 1", KEY), true);
  assert.equal(replacedOutput(`/api/reader/ed%201/prepared/${KEY}/parts/0`, "ed 1", KEY), false);
  // The manifest's address is the current one's: it is written again, not removed.
  assert.equal(replacedOutput("/api/reader/ed%201/prepared", "ed 1", KEY), false);
});

test("the cache: the service worker answers pictures from it, and Reset this device leaves it", () => {
  const worker = readFileSync("public/sw.js", "utf8");
  assert.match(worker, new RegExp(`const KEPT_TEXT = "${KEPT_TEXT_CACHE}";`));
  const reset = readFileSync("src/components/DeviceReset.tsx", "utf8");
  const cleared = [...reset.matchAll(/name\.startsWith\("([^"]+)"\)/g)].map((found) => found[1]!);
  assert.ok(cleared.length > 0, "Reset names the caches it clears");
  for (const prefix of cleared) assert.equal(KEPT_TEXT_CACHE.startsWith(prefix), false, prefix);
});
