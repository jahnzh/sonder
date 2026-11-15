import type { MediaFault, PlaybackSourceChoice, RecordingSources, Track } from "./types";
import { canFallBackToDevice, offlinePreference, skipStream, type StreamRequest } from "./device-fallback";
// The delivery source for a play (ADR 0015): which copy plays first, what the
// page switches to when it is unavailable or fails, and what the player shows.
// Pure, so every combination is unit-tested in Node. The service worker keeps
// its own frozen rule for `source=auto`; the plan reaches it only through the
// `source` parameter of the stream it asks for.

export type ShownSource = "device" | "server" | "torbox" | "remote";

export type DeviceStep = { source: "device" };
export type StreamStep = {
  source: "stream";
  /** `?source=` on the media and location requests; automatic sends none. */
  request: StreamRequest;
  /** Shown until the server or the service worker reports the real source. */
  show: ShownSource;
  /**
   * An explicit server or original stream: when the server is unreachable the
   * page may switch this play to the device copy (see `afterUnreachable`).
   */
  recover: boolean;
};
export type DeliveryStep = DeviceStep | StreamStep;

/** What the page knows before the sources request. */
export type LocalFacts = {
  /** The reader's stored choice for the recording. */
  chosen: PlaybackSourceChoice;
  deviceFault: MediaFault | undefined;
  /** The track's download row; whether its bytes are complete is learnt later. */
  download: unknown;
  recentFailure: boolean;
};

export type DeliveryFacts = LocalFacts & {
  online: boolean;
  sources: RecordingSources;
  track: Pick<Track, "id" | "serverAvailable" | "sourceType">;
};

export type DeliveryPlan = {
  /** The choice this play follows: the stored one, or the device copy offline. */
  preference: PlaybackSourceChoice;
  first: DeliveryStep;
  /**
   * In order after `first`. A device step is passed over when the copy turns
   * out to be incomplete; a device step after a recovering stream is where an
   * unreachable stream switches to.
   */
  fallbacks: DeliveryStep[];
  /** A recent outage sent an explicit stream to the device copy first. */
  remembered: boolean;
  /** Whether the source the player shows is flagged faulty for this play. */
  faulty: (shown: string | null) => boolean;
};

export type DeliveryDecision = DeliveryPlan | { error: string };

// A recent outage sends an explicit stream straight to the device copy, so the
// load reads the sources from the cache instead of waiting for a server that
// just failed. Decided on the stored choice, before the offline override.
export function sourcesFromCache(facts: LocalFacts) {
  const { chosen, recentFailure, download, deviceFault } = facts;
  return (
    (chosen === "server" || chosen === "original") &&
    skipStream({ request: chosen, recentFailure, download, fault: deviceFault })
  );
}

export function deliveryPlan(facts: DeliveryFacts): DeliveryDecision {
  const { sources, track, download, deviceFault: fault, recentFailure } = facts;
  const preference = offlinePreference(facts.chosen, facts.online, download, fault);
  if (sources.faults.recording)
    return {
      error:
        "This recording is marked faulty. Open Versions & sources to choose another recording or clear its flag.",
    };
  const available = sources.tracks.find((item) => item.id === track.id) || {
    server: track.serverAvailable || track.sourceType === "local",
    original: track.sourceType !== "local",
  };
  const server = available.server && !sources.faults.server,
    original = available.original && !sources.faults.original;
  if (preference === "device" && (!download || fault))
    return {
      error: "This device copy is missing or marked faulty. Choose another source in Versions & sources.",
    };
  if (preference === "server" && !server)
    return {
      error: "This server copy is missing or marked faulty. Choose another source in Versions & sources.",
    };
  if (preference === "original" && !original)
    return {
      error:
        "The original stream is unavailable or marked faulty. Choose another source in Versions & sources.",
    };
  if (preference === "auto" && (!download || fault) && !server && !original)
    return {
      error: "No healthy audio source is available. Open Versions & sources to choose another recording.",
    };
  const explicit = preference === "server" || preference === "original";
  const request: StreamRequest = explicit
    ? preference
    : sources.faults.server
      ? "original"
      : sources.faults.original
        ? "server"
        : "auto";
  const originalShown: ShownSource = track.sourceType === "torbox" ? "torbox" : "remote";
  const stream: StreamStep = {
    source: "stream",
    request,
    show:
      request === "server"
        ? "server"
        : request === "original"
          ? originalShown
          : server
            ? "server"
            : originalShown,
    recover: explicit,
  };
  const device: DeviceStep = { source: "device" };
  const remembered =
    explicit && skipStream({ request: preference, recentFailure, download, fault });
  // A complete download exists, so an unreachable stream has somewhere to go.
  const deviceCopy = !!download && !fault;
  const order: DeliveryStep[] =
    preference === "device"
      ? [device]
      : preference === "auto"
        ? fault
          ? [stream]
          : [device, stream]
        : remembered
          ? [device, stream, device]
          : deviceCopy
            ? [stream, device]
            : [stream];
  return {
    preference,
    first: order[0],
    fallbacks: order.slice(1),
    remembered,
    faulty: (shown) =>
      shown === "device"
        ? !!fault
        : shown === "server"
          ? !!sources.faults.server
          : !!sources.faults.original,
  };
}

/** The steps of a plan in the order they are tried. */
export const deliverySteps = (plan: DeliveryPlan) => [plan.first, ...plan.fallbacks];

/** Whether the load has to look for the device copy before it starts. */
export const looksForDevice = (plan: DeliveryPlan) => plan.first.source === "device";

// The step a load starts with once it knows whether the device copy's bytes are
// complete; null when the plan has nothing left but an incomplete device copy.
export function startingStep(plan: DeliveryPlan, deviceCopyComplete: boolean): DeliveryStep | null {
  for (const step of deliverySteps(plan))
    if (step.source === "stream" || deviceCopyComplete) return step;
  return null;
}

// Whether a stall on `step` may switch to the device copy (a device step follows
// it in the plan) rather than surface an error once the server is unreachable.
export function stallFallsBackToDevice(plan: DeliveryPlan, step: DeliveryStep) {
  const steps = deliverySteps(plan);
  return steps[steps.indexOf(step) + 1]?.source === "device";
}

// Where a recovering stream goes once the server proved unreachable, with the
// download row and device fault read again at that moment: the device copy
// when one is healthy now (its bytes are still checked), otherwise nowhere.
export function afterUnreachable(
  step: StreamStep,
  now: { download: unknown; deviceFault: MediaFault | undefined },
): DeviceStep | null {
  return step.recover && canFallBackToDevice(step.request, now.download, now.deviceFault)
    ? { source: "device" }
    : null;
}

/** The source the player shows for the step that is playing. */
export const shownFor = (step: DeliveryStep): ShownSource =>
  step.source === "device" ? "device" : step.show;

/** The stream the remembered-outage notice names when a load starts on the device copy. */
export function rememberedNotice(plan: DeliveryPlan, step: DeliveryStep): "server" | "original" | null {
  return plan.remembered && step.source === "device"
    ? plan.preference === "original"
      ? "original"
      : "server"
    : null;
}

// A later report of the source actually used replaces the shown one, except
// while a device blob plays (the page knows its source) or for another load.
// The location answer also yields to the service worker, which saw the real
// request. Returns the source to show, or null to keep the current one.
export function reportedSource(
  report:
    | { from: "location"; source: ShownSource; currentLoad: boolean; playingDeviceCopy: boolean; workerReported: boolean }
    | { from: "worker"; source: unknown; currentLoad: boolean; playingDeviceCopy: boolean },
): ShownSource | null {
  if (!report.currentLoad || report.playingDeviceCopy) return null;
  if (report.from === "location") return report.workerReported ? null : report.source;
  return ["device", "server", "torbox", "remote"].includes(report.source as string)
    ? (report.source as ShownSource)
    : null;
}
