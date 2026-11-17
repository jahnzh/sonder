// The line under Get this recording (#603, spec #600 "What the line under the button says"): one pure function of the
// chosen row, the work's media state, TorBox and the torrent client's health. Each case, the order when several hold,
// and `replaceActive` set exactly when the line says the add replaces the download on its way.
import assert from "node:assert/strict";
import test from "node:test";
import { getLine, type GetLineFacts } from "../src/pages/get-audiobook-rows";
import type { AudiobookRelease, WorkMediaState } from "../src/types";

type Chosen = Exclude<GetLineFacts["chosen"], "magnet" | null>;
const abb: Chosen = { source: "abb" };
const abbMerged: Chosen = { source: "abb", infoHash: "1".repeat(40), cached: false };
const prowlarr: Chosen = { source: "prowlarr", infoHash: "2".repeat(40), cached: false };
const cachedProwlarr: Chosen = { source: "prowlarr", infoHash: "3".repeat(40), cached: true };
const cachedAbb: Chosen = { source: "abb", infoHash: "4".repeat(40), cached: true };
// A release from an older answer without a source field reads as AudioBookBay's.
const sourceless: Chosen = {} as Pick<AudiobookRelease, "cached" | "source" | "infoHash">;

const queued = (status: string | null, progress: number | null = null): WorkMediaState => ({
  state: "queued",
  holdReason: null,
  acquisition: { id: "on-its-way", status, progress, error: null },
});
const ok = { status: "ok", message: "Local torrents are working." } as const;
const unconfigured = { status: "unconfigured", message: "Local torrents are not configured. Run the local torrent setup script on your server." } as const;
const down = { status: "unreachable", message: "The local torrent client cannot be reached." } as const;
const auth = { status: "auth", message: "Transmission rejected the username or password." } as const;
const offline = { status: "offline", message: "The torrent client cannot reach the network." } as const;
const error = { status: "error", message: "The torrent client answered with an error." } as const;

const facts = (over: Partial<GetLineFacts>): GetLineFacts => ({
  chosen: abb,
  mediaState: null,
  torboxConnected: true,
  health: ok,
  ...over,
});
const line = (over: Partial<GetLineFacts>) => getLine(facts(over));
const text = (over: Partial<GetLineFacts>) => line(over)?.text;

const REPLACES = /^Replaces the download on its way \(.+\)\.$/;
const TORBOX = "Plays from TorBox right away.";
const SERVER = "Downloads to your server first.";
const EITHER = "Plays at once if TorBox has it, else downloads to your server.";

test("nothing chosen: no line, whatever else holds", () => {
  assert.equal(line({ chosen: null }), null);
  assert.equal(line({ chosen: null, mediaState: queued("downloading", 0.43) }), null);
  assert.equal(line({ chosen: null, torboxConnected: false, health: down }), null);
});

test("a download on its way: the line says it is replaced, with its status line, and replaceActive is set", () => {
  assert.deepEqual(line({ mediaState: queued("downloading", 0.43) }), {
    text: "Replaces the download on its way (Downloading to server · 43%).",
    failed: false,
    replaceActive: true,
  });
  assert.equal(text({ mediaState: queued("checking") }), "Replaces the download on its way (Finding a source).");
  assert.equal(text({ mediaState: queued("preparing") }), "Replaces the download on its way (Preparing the stream).");
  assert.equal(text({ mediaState: queued("paused", 0.5) }), "Replaces the download on its way (Paused · 50%).");
  // A status outside the vocabulary (a newer server) and an unknown one read as the first step.
  assert.equal(text({ mediaState: queued("unknown-status") }), "Replaces the download on its way (Finding a source).");
  assert.equal(text({ mediaState: queued(null) }), "Replaces the download on its way (Finding a source).");
});

test("the replace line comes first: before a cached row, TorBox not connected, a broken torrent client and a magnet link", () => {
  const onItsWay = queued("downloading", 0.43);
  for (const over of [
    { chosen: cachedProwlarr },
    { chosen: cachedAbb },
    { chosen: prowlarr },
    { chosen: abb },
    { chosen: "magnet" as const },
    { chosen: prowlarr, health: down },
    { chosen: abb, torboxConnected: false, health: down },
    { chosen: cachedProwlarr, torboxConnected: false },
  ]) {
    const result = line({ ...over, mediaState: onItsWay });
    assert.match(result?.text ?? "", REPLACES, JSON.stringify(over));
    assert.equal(result?.replaceActive, true);
    assert.equal(result?.failed, false);
  }
});

test("a media state that is not a download on its way replaces nothing", () => {
  for (const state of ["missing", "failed", "available"] as const)
    assert.equal(line({ mediaState: { state, holdReason: null, acquisition: null } })?.replaceActive, false, state);
  // Queued without its acquisition (not the administrator's view): nothing to name, nothing replaced.
  assert.equal(line({ mediaState: { state: "queued", holdReason: null, acquisition: null } })?.replaceActive, false);
  // A failed download is not on its way.
  assert.equal(
    text({ mediaState: { state: "failed", holdReason: null, acquisition: { id: "x", status: "error", progress: null, error: "x" } } }),
    EITHER,
  );
  // A second recording for a book that already has one: the first stays, nothing is replaced.
  assert.deepEqual(line({ mediaState: { state: "available", holdReason: null, acquisition: null }, chosen: prowlarr }), {
    text: SERVER,
    failed: false,
    replaceActive: false,
  });
});

test("a cached row plays from TorBox, before the torrent client's trouble and whatever source listed it", () => {
  assert.deepEqual(line({ chosen: cachedProwlarr }), { text: TORBOX, failed: false, replaceActive: false });
  assert.equal(text({ chosen: cachedAbb }), TORBOX);
  assert.equal(text({ chosen: cachedProwlarr, health: down }), TORBOX);
  // A row is cached only from TorBox's own check, so the line follows the row even if TorBox reads as not connected.
  assert.equal(text({ chosen: cachedProwlarr, torboxConnected: false }), TORBOX);
});

test("TorBox not connected: every row downloads to the server first", () => {
  for (const chosen of [abb, abbMerged, prowlarr, sourceless, "magnet" as const])
    assert.deepEqual(line({ chosen, torboxConnected: false }), { text: SERVER, failed: false, replaceActive: false }, JSON.stringify(chosen));
});

test("a row TorBox checked and does not have downloads to the server first", () => {
  assert.equal(text({ chosen: prowlarr }), SERVER);
  // An AudioBookBay row merged with a Prowlarr copy has its info hash: it was checked too.
  assert.equal(text({ chosen: abbMerged }), SERVER);
});

test("the torrent client's message in the failed colour when it is neither ok nor unconfigured", () => {
  for (const health of [down, auth, offline, error]) {
    assert.deepEqual(line({ chosen: prowlarr, health }), { text: health.message, failed: true, replaceActive: false }, health.status);
    assert.deepEqual(line({ chosen: abb, torboxConnected: false, health }), { text: health.message, failed: true, replaceActive: false });
    assert.deepEqual(line({ chosen: "magnet", torboxConnected: false, health }), { text: health.message, failed: true, replaceActive: false });
  }
  // Ok, unconfigured and not read yet: the plain line.
  for (const health of [ok, unconfigured, null, undefined]) assert.equal(text({ chosen: prowlarr, health }), SERVER, String(health?.status));
  // A failing client without a message of its own keeps the plain line rather than an empty one.
  assert.equal(text({ chosen: prowlarr, health: { status: "error", message: " " } }), SERVER);
});

test("an AudioBookBay row or a magnet link with TorBox connected: plays at once if TorBox has it", () => {
  assert.deepEqual(line({ chosen: abb }), { text: EITHER, failed: false, replaceActive: false });
  assert.equal(text({ chosen: sourceless }), EITHER);
  assert.equal(text({ chosen: "magnet" }), EITHER);
  // TorBox checks it when it is got; the torrent client is needed only on a miss, so its trouble does not show here.
  assert.equal(text({ chosen: abb, health: down }), EITHER);
});

test("replaceActive is set exactly when the line says it replaces", () => {
  const chosens: GetLineFacts["chosen"][] = [abb, abbMerged, prowlarr, cachedProwlarr, cachedAbb, sourceless, "magnet", null];
  const states: GetLineFacts["mediaState"][] = [
    null,
    undefined,
    queued("downloading", 0.2),
    queued(null),
    { state: "queued", holdReason: null, acquisition: null },
    { state: "missing", holdReason: "empty_search", acquisition: null },
    { state: "failed", holdReason: null, acquisition: { id: "f", status: "error", progress: null, error: "x" } },
    { state: "available", holdReason: null, acquisition: null },
  ];
  let replacing = 0;
  for (const chosen of chosens)
    for (const mediaState of states)
      for (const torboxConnected of [true, false])
        for (const health of [ok, unconfigured, down, null]) {
          const result = getLine({ chosen, mediaState, torboxConnected, health });
          if (!result) {
            assert.equal(chosen, null);
            continue;
          }
          assert.equal(result.replaceActive, REPLACES.test(result.text), result.text);
          assert.equal(result.replaceActive, result.text.startsWith("Replaces"), result.text);
          if (result.replaceActive) replacing++;
        }
  assert.ok(replacing > 0);
});
