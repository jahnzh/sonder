/**
 * A stuck download says why and offers Cancel (#716). Pure: the reason per Transmission state, the tables of actions
 * per status, and what Activity makes of a stuck, a failing, a blocked and a moving download. No torrent client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeTracker, buildActivity } from "../server/activity.ts";
import {
  ACQUISITION_ACTIONS, ACQUISITION_STUCK_ACTIONS, STUCK_DOWNLOAD_REASONS, acquisitionSource, stuckDownloadCause, stuckDownloadReason,
  type AcquisitionProbe, type TorrentLookup,
} from "../server/acquisitions-activity.ts";
import { ACQUISITION_STATUSES, type AcquisitionJobStatus } from "../server/schema.ts";
import type { TorrentState } from "../server/transmission.ts";
import type { ActivityItemAction, TorrentHealth } from "../src/types.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
const HASH = "38136ad6".padEnd(40, "0");

/** A torrent as Transmission's `torrent-get` answers it, healthy unless told otherwise. */
const torrent = (over: Partial<TorrentState> = {}): TorrentState => ({
  hashString: HASH, status: 4, error: 0, errorString: "", percentDone: 0.0011, metadataPercentComplete: 1,
  peersConnected: 3, peersSendingToUs: 1, trackerStats: [{ seederCount: 4 }], ...over,
});
const states = (...torrents: TorrentState[]): TorrentLookup => ({ states: new Map(torrents.map((t) => [t.hashString, t])) });

test("the reason per Transmission state: each cause the client knows, in order, and none when nothing explains it", () => {
  const cases: Array<[string, TorrentLookup | null, string | null]> = [
    ["the client cannot be reached", { failure: "unreachable" }, "Torrent client unreachable"],
    ["the client answered with something else (credentials, RPC)", { failure: "other" }, null],
    ["the client does not have the torrent", states(), "Not in the torrent client"],
    ["a tracker's error, with its message", states(torrent({ error: 2, errorString: "Tracker gave HTTP response code 404" })), "Tracker error: Tracker gave HTTP response code 404"],
    ["a tracker's warning", states(torrent({ error: 1, errorString: "" })), "Tracker error"],
    ["a local error of the client", states(torrent({ error: 3, errorString: "No data found!" })), "Torrent client error: No data found!"],
    ["metadata not received", states(torrent({ metadataPercentComplete: 0, peersConnected: 0 })), "Metadata not received"],
    ["no peer connected", states(torrent({ peersConnected: 0, peersSendingToUs: 0, trackerStats: [] })), "No peers"],
    ["no peer and every tracker counts no seeder", states(torrent({ peersConnected: 0, peersSendingToUs: 0, trackerStats: [{ seederCount: 0 }, { seederCount: -1 }] })), "No seeders"],
    ["no peer, a tracker counts seeders", states(torrent({ peersConnected: 0, peersSendingToUs: 0, trackerStats: [{ seederCount: 0 }, { seederCount: 2 }] })), "No peers"],
    ["peers but none sends", states(torrent({ peersSendingToUs: 0 })), "No seeders"],
    ["peers send: nothing explains it", states(torrent()), null],
    ["the client was not asked", null, null],
  ];
  for (const [name, lookup, reason] of cases) assert.equal(stuckDownloadReason(lookup, HASH), reason, name);
  assert.equal(stuckDownloadCause(states(torrent()), null), null, "a download without a hash names no cause");
  assert.equal(stuckDownloadCause(states(torrent()), HASH.toUpperCase()), null, "the hash is matched in any case");
  const long = "x".repeat(200);
  assert.equal(stuckDownloadReason(states(torrent({ error: 2, errorString: long })), HASH)?.length, "Tracker error: ".length + 80, "a long message is cut");
  assert.deepEqual(Object.keys(STUCK_DOWNLOAD_REASONS).sort(), ["client-error", "metadata", "missing", "no-peers", "no-seeders", "tracker", "unreachable"]);
});

test("the actions table: Cancel for a failed download and for a stuck one that has a source; Retry and Resume as before", () => {
  const always = {
    checking: [], preparing: [], downloading: [], paused: ["resume"], ready: [], error: ["retry", "cancel"], cancelled: [],
  } satisfies Record<AcquisitionJobStatus, ActivityItemAction[]>;
  const whenStuck = {
    checking: [], preparing: ["cancel"], downloading: ["cancel"], paused: [], ready: [], error: [], cancelled: [],
  } satisfies Record<AcquisitionJobStatus, ActivityItemAction[]>;
  assert.deepEqual(Object.keys(always).sort(), [...ACQUISITION_STATUSES].sort(), "the walk covers the whole vocabulary");
  for (const status of ACQUISITION_STATUSES) {
    assert.deepEqual(ACQUISITION_ACTIONS[status], always[status], status);
    assert.deepEqual(ACQUISITION_STUCK_ACTIONS[status], whenStuck[status], `${status} while stuck`);
  }
});

const health = (over: Partial<TorrentHealth> = {}): TorrentHealth => ({
  status: "ok", session: true, network: "ok", version: "4.0.6", message: "ok", checkedAt: NOW, ...over,
});
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, hash: HASH, title: "A Game of Thrones", author: "George R. R. Martin", backend: "local", status: "downloading", progress: 0.0011,
  error: null, created_at: NOW - 19 * 24 * 60 * MIN, updated_at: NOW - MIN, ...over,
});
/** Activity's items for these rows, read once two hours ago and again now, so a download that did not move is stuck. */
function items(rows: ReturnType<typeof row>[], probe: AcquisitionProbe | null, failure: string | null = null) {
  const tracker = new ChangeTracker();
  const snapshots = [{ source: acquisitionSource, rows, probe: { value: probe, failure } }];
  buildActivity({ now: NOW - 120 * MIN, multiplier: 1, tracker, snapshots });
  return Object.fromEntries(buildActivity({ now: NOW, multiplier: 1, tracker, snapshots }).items.map((item) => [item.id, item]));
}

test("a stuck download names why when the client knows and offers Cancel; Retry stays with the failed download", () => {
  const byId = items([row("peers")], { health: health(), torrents: states(torrent({ peersConnected: 0, peersSendingToUs: 0, trackerStats: [] })) });
  const stuck = byId["acquisition:peers"];
  assert.deepEqual(stuck.stuck, { reason: "No peers", known: true });
  assert.equal(stuck.attention, true);
  assert.deepEqual(stuck.actions, ["cancel"], "re-adding a torrent the client has mends nothing: Cancel only");

  const gone = items([row("gone")], { health: health(), torrents: states() })["acquisition:gone"];
  assert.deepEqual(gone.stuck, { reason: "Not in the torrent client", known: true });
  assert.deepEqual(gone.actions, ["cancel"], "the queue marks it failed on its next check, which offers Retry");
});

test("otherwise the stuck line stays 'No change for …'; a TorBox download is never asked about the local client", () => {
  const moving = items([row("x")], { health: health(), torrents: states(torrent()) })["acquisition:x"];
  assert.deepEqual(moving.stuck, { reason: "No change for 2 h" });
  assert.deepEqual(moving.actions, ["cancel"]);
  const notAsked = items([row("y")], { health: health(), torrents: null })["acquisition:y"];
  assert.deepEqual(notAsked.stuck, { reason: "No change for 2 h" });
  const failedProbe = items([row("z")], null, "it took too long")["acquisition:z"];
  assert.deepEqual(failedProbe.stuck, { reason: "No change for 2 h" }, "a probe that failed names no cause");
  assert.deepEqual(failedProbe.actions, ["cancel"]);
  const torbox = items([row("tb", { backend: "torbox", status: "preparing" })], { health: health(), torrents: states() })["acquisition:tb"];
  assert.deepEqual(torbox.stuck, { reason: "No change for 2 h" }, "a TorBox download is not 'Not in the torrent client'");
  assert.deepEqual(torbox.actions, ["cancel"]);
});

test("a moving download offers nothing new; a blocked one says Blocked and offers no Cancel; a failed one offers Retry and Cancel", () => {
  const tracker = new ChangeTracker();
  const fresh = buildActivity({
    now: NOW, multiplier: 1, tracker,
    snapshots: [{ source: acquisitionSource, rows: [row("new")], probe: { value: { health: health(), torrents: states() }, failure: null } }],
  }).items[0];
  assert.equal(fresh.stuck, null, "first seen now: not stuck");
  assert.deepEqual(fresh.actions, [], "Cancel is offered once the download is stuck");

  const down = health({ status: "unreachable", session: false, network: "unknown", message: "The local torrent client cannot be reached." });
  const blocked = items([row("b")], { health: down, torrents: { failure: "unreachable" } })["acquisition:b"];
  assert.deepEqual(blocked.stuck, { reason: "Blocked by Torrent client" });
  assert.deepEqual(blocked.actions, [], "the client is down: nothing could remove the torrent");

  const failed = items([row("f", { status: "error", error: "This torrent is no longer in the local queue. Retry to add it again." })], { health: health(), torrents: null })["acquisition:f"];
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.actions, ["retry", "cancel"]);
});

test("a cancelled download is finished: listed for a day, with no action and no attention", () => {
  const byId = items([row("c", { status: "cancelled", updated_at: NOW - 5 * MIN })], { health: health(), torrents: null });
  const cancelled = byId["acquisition:c"];
  assert.equal(cancelled.state, "done");
  assert.deepEqual(cancelled.actions, []);
  assert.equal(cancelled.attention, false);
  assert.equal(cancelled.stuck, null);
  assert.deepEqual(cancelled.facts, { kind: "acquisition", status: "cancelled", backend: "local" });
});

test("the probe asks the client only about local downloads that are fetching, and survives the client failing", async () => {
  const asked: string[][] = [];
  const deps = {
    torrentHealth: async () => health(),
    torrentStates: async (hashes: string[]) => { asked.push(hashes); return [torrent()]; },
  } as any;
  const rows = [
    row("a"), row("b", { hash: "B".repeat(40), status: "preparing" }), row("c", { hash: "c".repeat(40), status: "paused" }),
    row("d", { hash: "d".repeat(40), status: "error" }), row("e", { hash: "e".repeat(40), backend: "torbox" }), row("f", { hash: null }),
  ];
  const probe = (await acquisitionSource.probe!(deps, rows)) as AcquisitionProbe;
  assert.deepEqual(asked, [[HASH, "b".repeat(40)]]);
  assert.ok(probe.torrents && "states" in probe.torrents && probe.torrents.states.has(HASH));

  const unreachable = Object.assign(new Error("The local torrent client cannot be reached."), { failure: "unreachable" });
  const failing = (await acquisitionSource.probe!({ ...deps, torrentStates: async () => { throw unreachable; } }, rows)) as AcquisitionProbe;
  assert.deepEqual(failing.torrents, { failure: "unreachable" });
  assert.deepEqual(failing.health, health(), "the client's health is still reported");
  const none = (await acquisitionSource.probe!({ ...deps, torrentStates: async () => { throw new Error("x"); } }, [row("p", { status: "paused" })])) as AcquisitionProbe;
  assert.equal(none.torrents, null, "nothing fetching: the client is not asked");
});
