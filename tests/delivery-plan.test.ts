import { test } from "node:test";
import assert from "node:assert/strict";
import type { MediaFault, PlaybackSourceChoice, RecordingSources } from "../src/types.ts";
import {
  legacyOutcome,
  legacyRecovers,
  legacyTakesLocation,
  legacyTakesWorkerReport,
  type LegacyFacts,
  type LegacyLoad,
  type LegacyOutcome,
} from "./delivery-legacy.ts";
import {
  afterUnreachable,
  deliveryPlan,
  looksForDevice,
  rememberedNotice,
  reportedSource,
  shownFor,
  sourcesFromCache,
  stallFallsBackToDevice,
  startingStep,
  type DeliveryPlan,
  type DeliveryStep,
  type StreamStep,
} from "../src/delivery-plan.ts";

// Issue #396: the choice of delivery source and its fallback order, pinned as
// a table of the behaviour before the decision moved into one module, and the
// plan checked against that table and against the frozen reference for every
// combination of its inputs.

const fault: MediaFault = { reason: "bad-audio", note: "", updatedAt: 1 };
const download = { trackId: "t1" };

type Setup = {
  chosen?: PlaybackSourceChoice;
  deviceFault?: boolean;
  download?: boolean;
  online?: boolean;
  recentFailure?: boolean;
  recordingFault?: boolean;
  serverFault?: boolean;
  originalFault?: boolean;
  /** The track's row in the recording's sources; null when the row is missing. */
  row?: { server: boolean; original: boolean } | null;
  serverAvailable?: boolean;
  sourceType?: "local" | "remote" | "torbox";
};

function facts(setup: Setup = {}): LegacyFacts {
  const faults: RecordingSources["faults"] = {};
  if (setup.recordingFault) faults.recording = fault;
  if (setup.serverFault) faults.server = fault;
  if (setup.originalFault) faults.original = fault;
  const row = setup.row === undefined ? { server: true, original: true } : setup.row;
  return {
    chosen: setup.chosen ?? "auto",
    deviceFault: setup.deviceFault ? fault : undefined,
    download: setup.download ? download : undefined,
    online: setup.online ?? true,
    recentFailure: setup.recentFailure ?? false,
    sources: {
      recordingId: "r1",
      faults,
      managedCopies: 0,
      serverFiles: 1,
      originalFiles: 1,
      tracks: row ? [{ id: "t1", ...row }, { id: "t2", server: false, original: false }] : [{ id: "t2", server: false, original: false }],
    },
    track: {
      id: "t1",
      serverAvailable: setup.serverAvailable ?? true,
      sourceType: setup.sourceType ?? "remote",
    },
  };
}

const errors = {
  recording:
    "This recording is marked faulty. Open Versions & sources to choose another recording or clear its flag.",
  device: "This device copy is missing or marked faulty. Choose another source in Versions & sources.",
  server: "This server copy is missing or marked faulty. Choose another source in Versions & sources.",
  original:
    "The original stream is unavailable or marked faulty. Choose another source in Versions & sources.",
  none: "No healthy audio source is available. Open Versions & sources to choose another recording.",
  incomplete:
    "This device copy is incomplete. Remove it and download it again, or choose another source.",
};

const onDevice = (notice: "server" | "original" | null = null): LegacyLoad => ({
  plays: "device",
  show: "device",
  notice,
});
const stream = (
  request: "auto" | "server" | "original",
  show: "server" | "torbox" | "remote",
  deviceCopy?: boolean,
): LegacyLoad => ({
  plays: "stream",
  query: request === "auto" ? "" : `?source=${request}`,
  show,
  location: request,
  streamLoad:
    deviceCopy === undefined
      ? null
      : { request: request as "server" | "original", deviceCopy },
});
const incomplete: LegacyLoad = { error: errors.incomplete };
const healthy = { device: false, server: false, torbox: false, remote: false, none: false };

function plays(
  preference: PlaybackSourceChoice,
  looksForDevice: boolean,
  complete: LegacyLoad,
  incompleteLoad: LegacyLoad,
  options: { sourcesFromCache?: boolean; faulty?: Partial<typeof healthy> } = {},
): LegacyOutcome {
  return {
    sourcesFromCache: options.sourcesFromCache ?? false,
    result: {
      preference,
      looksForDevice,
      complete,
      incomplete: incompleteLoad,
      faulty: { ...healthy, ...options.faulty },
    },
  };
}
const refused = (error: string, sourcesFromCache = false): LegacyOutcome => ({
  sourcesFromCache,
  result: { error },
});

// Every combination the decision distinguishes, with the result the code gave
// before #396. `complete`/`incomplete` are the two answers of `offlineUrl`.
const table: [string, Setup, LegacyOutcome][] = [
  // Automatic: a complete device copy first, then the stream the faults allow.
  ["auto, nothing faulty", {}, plays("auto", true, onDevice(), stream("auto", "server"))],
  ["auto with a download", { download: true }, plays("auto", true, onDevice(), stream("auto", "server"))],
  ["auto offline", { download: true, online: false }, plays("auto", true, onDevice(), stream("auto", "server"))],
  ["auto ignores a recent outage", { download: true, recentFailure: true }, plays("auto", true, onDevice(), stream("auto", "server"))],
  [
    "auto with a faulty device copy streams only",
    { download: true, deviceFault: true },
    plays("auto", false, stream("auto", "server"), stream("auto", "server"), { faulty: { device: true } }),
  ],
  [
    "auto with a faulty server copy streams the original",
    { serverFault: true },
    plays("auto", true, onDevice(), stream("original", "remote"), { faulty: { server: true } }),
  ],
  [
    "auto with a faulty server copy streams the TorBox original",
    { serverFault: true, sourceType: "torbox" },
    plays("auto", true, onDevice(), stream("original", "torbox"), { faulty: { server: true } }),
  ],
  [
    "auto with a faulty original streams the server copy",
    { originalFault: true },
    plays("auto", true, onDevice(), stream("server", "server"), {
      faulty: { torbox: true, remote: true, none: true },
    }),
  ],
  [
    "auto with both streams faulty still asks for the original after the device copy",
    { download: true, serverFault: true, originalFault: true },
    plays("auto", true, onDevice(), stream("original", "remote"), {
      faulty: { server: true, torbox: true, remote: true, none: true },
    }),
  ],
  [
    "auto with both streams faulty and no download is refused",
    { serverFault: true, originalFault: true },
    refused(errors.none),
  ],
  [
    "auto with a faulty device copy and no healthy stream is refused",
    { download: true, deviceFault: true, row: { server: false, original: true }, originalFault: true },
    refused(errors.none),
  ],
  [
    "auto shows the original when the track has no server copy",
    { row: { server: false, original: true } },
    plays("auto", true, onDevice(), stream("auto", "remote")),
  ],
  [
    "auto shows TorBox when the track has no server copy",
    { row: { server: false, original: true }, sourceType: "torbox" },
    plays("auto", true, onDevice(), stream("auto", "torbox")),
  ],
  [
    "a track missing from the sources falls back to its own fields (local)",
    { row: null, sourceType: "local", serverAvailable: false },
    plays("auto", true, onDevice(), stream("auto", "server")),
  ],
  [
    "a track missing from the sources falls back to its own fields (remote, no server copy)",
    { row: null, serverAvailable: false },
    plays("auto", true, onDevice(), stream("auto", "remote")),
  ],
  [
    "a missing local track has no original",
    { row: null, sourceType: "local", chosen: "original" },
    refused(errors.original),
  ],
  // Device copy chosen: the device copy or an error, never a stream.
  ["device copy chosen", { chosen: "device", download: true }, plays("device", true, onDevice(), incomplete)],
  ["device copy chosen, offline", { chosen: "device", download: true, online: false }, plays("device", true, onDevice(), incomplete)],
  ["device copy chosen without a download", { chosen: "device" }, refused(errors.device)],
  ["device copy chosen but faulty", { chosen: "device", download: true, deviceFault: true }, refused(errors.device)],
  // Server copy chosen.
  ["server chosen", { chosen: "server" }, plays("server", false, stream("server", "server", false), stream("server", "server", false))],
  [
    "server chosen with a download keeps a device copy for a stall",
    { chosen: "server", download: true },
    plays("server", false, stream("server", "server", true), stream("server", "server", true)),
  ],
  [
    "server chosen after a recent outage goes to the device copy first",
    { chosen: "server", download: true, recentFailure: true },
    plays("server", true, onDevice("server"), stream("server", "server", true), { sourcesFromCache: true }),
  ],
  [
    "a recent outage without a download streams",
    { chosen: "server", recentFailure: true },
    plays("server", false, stream("server", "server", false), stream("server", "server", false)),
  ],
  [
    "a recent outage with a faulty device copy streams",
    { chosen: "server", download: true, deviceFault: true, recentFailure: true },
    plays("server", false, stream("server", "server", false), stream("server", "server", false), { faulty: { device: true } }),
  ],
  [
    "server chosen offline plays the device copy without a notice",
    { chosen: "server", download: true, online: false },
    plays("device", true, onDevice(), incomplete),
  ],
  [
    "server chosen offline after an outage reads the cached sources",
    { chosen: "server", download: true, online: false, recentFailure: true },
    plays("device", true, onDevice(), incomplete, { sourcesFromCache: true }),
  ],
  [
    "server chosen offline without a download still streams",
    { chosen: "server", online: false },
    plays("server", false, stream("server", "server", false), stream("server", "server", false)),
  ],
  [
    "server chosen offline with a faulty device copy still streams",
    { chosen: "server", online: false, download: true, deviceFault: true },
    plays("server", false, stream("server", "server", false), stream("server", "server", false), { faulty: { device: true } }),
  ],
  ["server chosen but faulty", { chosen: "server", serverFault: true }, refused(errors.server)],
  ["server chosen but the track has no server copy", { chosen: "server", row: { server: false, original: true } }, refused(errors.server)],
  [
    "a faulty server copy is refused even after an outage with a download",
    { chosen: "server", serverFault: true, download: true, recentFailure: true },
    refused(errors.server, true),
  ],
  [
    "server chosen ignores a faulty original",
    { chosen: "server", originalFault: true },
    plays("server", false, stream("server", "server", false), stream("server", "server", false), {
      faulty: { torbox: true, remote: true, none: true },
    }),
  ],
  // Original chosen.
  ["original chosen", { chosen: "original" }, plays("original", false, stream("original", "remote", false), stream("original", "remote", false))],
  [
    "original chosen on TorBox",
    { chosen: "original", sourceType: "torbox", download: true },
    plays("original", false, stream("original", "torbox", true), stream("original", "torbox", true)),
  ],
  [
    "original chosen after a recent outage names the original in the notice",
    { chosen: "original", download: true, recentFailure: true },
    plays("original", true, onDevice("original"), stream("original", "remote", true), { sourcesFromCache: true }),
  ],
  [
    "original chosen offline plays the device copy",
    { chosen: "original", download: true, online: false },
    plays("device", true, onDevice(), incomplete),
  ],
  ["original chosen but faulty", { chosen: "original", originalFault: true }, refused(errors.original)],
  ["original chosen but the track has none", { chosen: "original", row: { server: true, original: false } }, refused(errors.original)],
  // A faulty recording refuses every choice.
  ["a faulty recording refuses auto", { recordingFault: true, download: true }, refused(errors.recording)],
  ["a faulty recording refuses the device copy", { recordingFault: true, chosen: "device", download: true }, refused(errors.recording)],
  [
    "a faulty recording is refused after the cached sources were read",
    { recordingFault: true, chosen: "original", download: true, recentFailure: true },
    refused(errors.recording, true),
  ],
];

// What `load` and the stream load in src/player.tsx do with a plan, in the
// shape of the reference: the same calls the player makes, nothing else.
function loadFromPlan(plan: DeliveryPlan, complete: boolean): LegacyLoad {
  // `offlineUrl` runs only when the plan starts with the device copy.
  const step = startingStep(plan, looksForDevice(plan) && complete);
  if (!step)
    return {
      error:
        "This device copy is incomplete. Remove it and download it again, or choose another source.",
    };
  if (step.source === "device")
    return { plays: "device", show: shownFor(step) as "device", notice: rememberedNotice(plan, step) };
  return {
    plays: "stream",
    query: step.request === "auto" ? "" : `?source=${step.request}`,
    show: shownFor(step) as "server" | "torbox" | "remote",
    location: step.request,
    streamLoad: step.recover
      ? { request: step.request as "server" | "original", deviceCopy: stallFallsBackToDevice(plan, step) }
      : null,
  };
}

function planOutcome(facts: LegacyFacts): LegacyOutcome {
  const cached = sourcesFromCache(facts);
  const plan = deliveryPlan(facts);
  if ("error" in plan) return { sourcesFromCache: cached, result: { error: plan.error } };
  return {
    sourcesFromCache: cached,
    result: {
      preference: plan.preference,
      looksForDevice: looksForDevice(plan),
      complete: loadFromPlan(plan, true),
      incomplete: loadFromPlan(plan, false),
      faulty: {
        device: plan.faulty("device"),
        server: plan.faulty("server"),
        torbox: plan.faulty("torbox"),
        remote: plan.faulty("remote"),
        none: plan.faulty(null),
      },
    },
  };
}

type Subject = (facts: LegacyFacts) => LegacyOutcome;
const subjects: [string, Subject][] = [
  ["before #396", legacyOutcome],
  ["plan", planOutcome],
];

for (const [label, subject] of subjects)
  for (const [name, setup, expected] of table)
    test(`${label}: ${name}`, () => {
      assert.deepEqual(subject(facts(setup)), expected);
    });

// Every combination of the inputs, for comparing a subject with the reference.
function* everyCombination(): Generator<Setup> {
  const bools = [false, true];
  const rows = [null, ...bools.flatMap((server) => bools.map((original) => ({ server, original })))];
  for (const chosen of ["auto", "device", "server", "original"] as const)
    for (const deviceFault of bools)
      for (const download of bools)
        for (const online of bools)
          for (const recentFailure of bools)
            for (const recordingFault of bools)
              for (const serverFault of bools)
                for (const originalFault of bools)
                  for (const row of rows)
                    for (const serverAvailable of bools)
                      for (const sourceType of ["local", "remote", "torbox"] as const)
                        yield {
                          chosen,
                          deviceFault,
                          download,
                          online,
                          recentFailure,
                          recordingFault,
                          serverFault,
                          originalFault,
                          row,
                          serverAvailable,
                          sourceType,
                        };
}

test("before #396: a stream switches to the device copy only for an explicit choice with a healthy download", () => {
  for (const request of ["server", "original"] as const) {
    assert.equal(legacyRecovers(request, download, undefined), true);
    assert.equal(legacyRecovers(request, undefined, undefined), false);
    assert.equal(legacyRecovers(request, download, fault), false);
  }
});

test("before #396: the location answer is shown only for the current streamed load the worker has not reported", () => {
  assert.equal(legacyTakesLocation({ currentLoad: true, playingDeviceCopy: false, workerReported: false }), true);
  assert.equal(legacyTakesLocation({ currentLoad: false, playingDeviceCopy: false, workerReported: false }), false);
  assert.equal(legacyTakesLocation({ currentLoad: true, playingDeviceCopy: true, workerReported: false }), false);
  assert.equal(legacyTakesLocation({ currentLoad: true, playingDeviceCopy: false, workerReported: true }), false);
});

test("before #396: the worker's report is shown for the current track unless a device blob plays", () => {
  for (const source of ["device", "server", "torbox", "remote"])
    assert.equal(legacyTakesWorkerReport({ sameTrack: true, source, playingDeviceCopy: false }), true);
  assert.equal(legacyTakesWorkerReport({ sameTrack: true, source: "cache", playingDeviceCopy: false }), false);
  assert.equal(legacyTakesWorkerReport({ sameTrack: false, source: "server", playingDeviceCopy: false }), false);
  assert.equal(legacyTakesWorkerReport({ sameTrack: true, source: "server", playingDeviceCopy: true }), false);
});

test("plan: matches the behaviour before #396 for every combination of its inputs", () => {
  let count = 0;
  for (const setup of everyCombination()) {
    count++;
    const input = facts(setup);
    assert.deepEqual(planOutcome(input), legacyOutcome(input), JSON.stringify(setup));
  }
  assert.equal(count, 4 * 2 ** 7 * 5 * 2 * 3);
});

const plan = (setup: Setup) => {
  const decision = deliveryPlan(facts(setup));
  assert.ok(!("error" in decision), "expected a plan");
  return decision;
};
const steps = (p: DeliveryPlan) =>
  [p.first, ...p.fallbacks].map((step) =>
    step.source === "device" ? "device" : `${step.request}${step.recover ? "!" : ""}`,
  );

test("plan: the order of sources for each kind of choice", () => {
  // "!" marks a stream that may switch to the device copy when unreachable.
  assert.deepEqual(steps(plan({})), ["device", "auto"]);
  assert.deepEqual(steps(plan({ deviceFault: true, download: true })), ["auto"]);
  assert.deepEqual(steps(plan({ serverFault: true })), ["device", "original"]);
  assert.deepEqual(steps(plan({ chosen: "device", download: true })), ["device"]);
  assert.deepEqual(steps(plan({ chosen: "server" })), ["server!"]);
  assert.deepEqual(steps(plan({ chosen: "server", download: true })), ["server!", "device"]);
  assert.deepEqual(steps(plan({ chosen: "original", download: true, recentFailure: true })), [
    "device",
    "original!",
    "device",
  ]);
  assert.deepEqual(steps(plan({ chosen: "original", download: true, online: false })), ["device"]);
});

test("plan: a refused play gives no plan", () => {
  assert.deepEqual(deliveryPlan(facts({ recordingFault: true })), { error: errors.recording });
  assert.deepEqual(deliveryPlan(facts({ chosen: "device" })), { error: errors.device });
});

test("plan: an unreachable stream goes to the device copy exactly when it did before #396", () => {
  const streams: StreamStep[] = [];
  for (const setup of everyCombination()) {
    const decision = deliveryPlan(facts(setup));
    if ("error" in decision) continue;
    for (const step of [decision.first, ...decision.fallbacks] as DeliveryStep[])
      if (step.source === "stream") streams.push(step);
  }
  const seen = new Set<string>();
  for (const step of streams)
    for (const now of [
      { download, deviceFault: undefined },
      { download: undefined, deviceFault: undefined },
      { download, deviceFault: fault },
      { download: undefined, deviceFault: fault },
    ]) {
      const switched = afterUnreachable(step, now);
      // The player recovers only explicit streams (its stream load).
      const before = step.recover
        ? legacyRecovers(step.request as "server" | "original", now.download, now.deviceFault)
        : false;
      assert.equal(!!switched, before, JSON.stringify({ step, now }));
      // recoverOnDevice shows the step it switched to.
      if (switched) {
        assert.deepEqual(switched, { source: "device" });
        assert.equal(shownFor(switched), "device");
      }
      seen.add(`${step.request}:${step.recover}:${!!switched}`);
    }
  // Every kind of stream the plan produces was compared.
  for (const key of ["auto:false:false", "server:true:true", "original:true:true", "server:false:false", "original:false:false"])
    assert.ok(seen.has(key), key);
});

test("plan: a reported source replaces the shown one exactly when it did before #396", () => {
  const bools = [false, true];
  for (const currentLoad of bools)
    for (const playingDeviceCopy of bools) {
      for (const workerReported of bools)
        for (const source of ["device", "server", "torbox", "remote"] as const)
          assert.equal(
            reportedSource({ from: "location", source, currentLoad, playingDeviceCopy, workerReported }),
            legacyTakesLocation({ currentLoad, playingDeviceCopy, workerReported }) ? source : null,
          );
      for (const source of ["device", "server", "torbox", "remote", "cache", undefined, 3])
        assert.equal(
          reportedSource({ from: "worker", source, currentLoad, playingDeviceCopy }),
          legacyTakesWorkerReport({ sameTrack: currentLoad, source, playingDeviceCopy }) ? source : null,
        );
    }
});
