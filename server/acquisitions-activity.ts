/**
 * Activity source of the download queue (`acquisitions`, ADR 0010). The vocabulary is `ACQUISITION_STATUSES` in
 * `server/schema.ts`: the table has no CHECK constraint, and the statuses are the ones `server/acquisitions.ts`,
 * `server/app.ts` (pause, resume, retry) and `server/series-removal.ts` write.
 */
import { ownCover, type ActivityHealth, type ActivityItemAction, type ActivityState, type TorrentHealth } from "../src/types.ts";
import type { AcquisitionJobStatus } from "./schema.ts";
import type { TorrentState } from "./transmission.ts";
import {
  activityFailure, assertOffered, clamp01, defineSource, itemWork, offeredActions, stateFrom, withWorks,
  type ActivityAction, type ItemWork,
} from "./activity-source.ts";

const MINUTE = 60_000;

export const ACQUISITION_ACTIVITY_STATES: Record<AcquisitionJobStatus, ActivityState> = {
  checking: "running",
  preparing: "running",
  downloading: "running",
  paused: "paused",
  ready: "done",
  error: "failed",
  // Cancelled from Activity (#716): finished, listed as such in Finished today for a day.
  cancelled: "done",
};

/**
 * What Activity offers for a download in each status (#515), through the Downloads page's control: Retry when it
 * failed, Resume when it is paused (only a local download can be paused, and the control refuses any other). A failed
 * download also offers Cancel (#716), which removes its torrent and ends it for good.
 */
export const ACQUISITION_ACTIONS: Record<AcquisitionJobStatus, readonly ActivityItemAction[]> = {
  checking: [],
  preparing: [],
  downloading: [],
  paused: ["resume"],
  ready: [],
  error: ["retry", "cancel"],
  cancelled: [],
};

/**
 * What a download offers besides those while it is stuck (#716): Cancel, once it has a source. A download still
 * finding a source is not cancelled under the hands of the one finding it.
 */
export const ACQUISITION_STUCK_ACTIONS: Record<AcquisitionJobStatus, readonly ActivityItemAction[]> = {
  checking: [],
  preparing: ["cancel"],
  downloading: ["cancel"],
  paused: [],
  ready: [],
  error: [],
  cancelled: [],
};

/** Why a stuck local download does not move, as the torrent client tells it (#716). */
export type StuckDownloadCause = "unreachable" | "missing" | "tracker" | "client-error" | "metadata" | "no-peers" | "no-seeders";

/** The reason a stuck download's line names for each cause. */
export const STUCK_DOWNLOAD_REASONS: Record<StuckDownloadCause, string> = {
  unreachable: "Torrent client unreachable",
  missing: "Not in the torrent client",
  tracker: "Tracker error",
  "client-error": "Torrent client error",
  metadata: "Metadata not received",
  "no-peers": "No peers",
  "no-seeders": "No seeders",
};


/**
 * What the torrent client said of the downloads' torrents: their states by hash, or why it could not be asked. Null
 * when it was not asked (no local download on its way).
 */
export type TorrentLookup =
  | { states: ReadonlyMap<string, TorrentState> }
  | { failure: "unreachable" | "other" };

/**
 * Why a local download does not move, from what Transmission says of its torrent (#716), or null when nothing it says
 * explains it (the line then keeps "No change for …"). The first that holds: the client cannot be reached, it does not
 * have the torrent, it reports an error (a tracker's, or its own), the metadata has not come, no peer is connected, or
 * peers are but none sends.
 */
export function stuckDownloadCause(lookup: TorrentLookup | null, hash: string | null | undefined): StuckDownloadCause | null {
  if (!lookup || !hash) return null;
  if ("failure" in lookup) return lookup.failure === "unreachable" ? "unreachable" : null;
  const torrent = lookup.states.get(hash.toLowerCase());
  if (!torrent) return "missing";
  // Transmission's `error`: 1 a tracker's warning, 2 a tracker's error, 3 a local error.
  if (torrent.error === 1 || torrent.error === 2) return "tracker";
  if (torrent.error === 3) return "client-error";
  if (Number.isFinite(torrent.metadataPercentComplete) && torrent.metadataPercentComplete < 1) return "metadata";
  if (torrent.peersConnected === 0) {
    const seeders = (torrent.trackerStats ?? []).map((tracker) => tracker.seederCount).filter((count) => Number.isFinite(count) && count >= 0);
    // Every tracker that counted says nobody seeds: the closer reason.
    return seeders.length && Math.max(...seeders) === 0 ? "no-seeders" : "no-peers";
  }
  if (torrent.peersSendingToUs === 0) return "no-seeders";
  return null;
}

/** The reason line of a stuck download: the cause's words, with the client's own message for an error. */
export function stuckDownloadReason(lookup: TorrentLookup | null, hash: string | null | undefined): string | null {
  const cause = stuckDownloadCause(lookup, hash);
  if (!cause) return null;
  const words = STUCK_DOWNLOAD_REASONS[cause];
  if ((cause === "tracker" || cause === "client-error") && lookup && "states" in lookup) {
    const message = lookup.states.get(String(hash).toLowerCase())?.errorString?.trim();
    if (message) return `${words}: ${message.length > 80 ? `${message.slice(0, 79)}…` : message}`;
  }
  return words;
}

const ITEM_PREFIX = "acquisition:";

/** Retry or Resume of a download: refused unless its stored status offers it, then the Downloads page's control. */
const control = (name: "retry" | "resume"): ActivityAction => async (id, { deps, log, userId }) => {
  const rowId = id.slice(ITEM_PREFIX.length);
  const row = deps.sqlite.prepare("SELECT status FROM acquisitions WHERE id = ?").get(rowId) as { status: string } | undefined;
  if (!row) throw activityFailure(404, "This download could not be found.");
  assertOffered(ACQUISITION_ACTIONS, row.status, name,
    name === "retry" ? "Only a download that failed can be retried." : "Only a paused download can be resumed.");
  log.info({ action: `activity.${name}`, acquisitionId: rowId }, name === "retry" ? "Download started again" : "Download resumed");
  return { ok: true, result: await deps.controlAcquisition(rowId, name, userId) };
};

/** Cancel of a stuck or failing download (#716): refused unless its stored status can be cancelled, then `cancelAcquisition`. */
const cancel: ActivityAction = async (id, { deps, log }) => {
  const rowId = id.slice(ITEM_PREFIX.length);
  const row = deps.sqlite.prepare("SELECT status FROM acquisitions WHERE id = ?").get(rowId) as { status: string } | undefined;
  if (!row) throw activityFailure(404, "This download could not be found.");
  if (!deps.cancelAcquisition) throw activityFailure(400, "This item cannot be cancelled.");
  const offered = [...offeredActions(ACQUISITION_ACTIONS, row.status), ...offeredActions(ACQUISITION_STUCK_ACTIONS, row.status)];
  if (!offered.includes("cancel"))
    throw activityFailure(409, row.status === "ready" ? "This download is finished; its recording stays." : "This download cannot be cancelled now.");
  const result = await deps.cancelAcquisition(rowId);
  log.info({ action: "activity.cancel", acquisitionId: rowId }, "Download cancelled");
  return { ok: true, result };
};

export type AcquisitionRow = {
  id: string;
  /** The torrent's info hash, to ask the client about it (#716); never sent to the page. */
  hash?: string | null;
  title: string;
  author: string | null;
  backend: string | null;
  status: string;
  progress: number | null;
  error: string | null;
  /** The download's own cover: shown while it has no work. */
  cover?: string | null;
  created_at: number;
  updated_at: number;
  /** The work it is for, once it has one. */
  work?: ItemWork | null;
  /**
   * The work already has a ready recording (one with a track) other than this download's own (#716): 1 or 0 as
   * SQLite answers. A stuck download of it is then `superseded`.
   */
  has_copy?: number | null;
};

export const TORRENT_CLIENT = { id: "torrent-client", label: "Torrent client" };

export function torrentProcessHealth(health: TorrentHealth | null, failure?: string | null): { health: ActivityHealth; reason: string | null } {
  if (!health) return { health: "unknown", reason: failure ? `The check failed: ${failure}` : "Not checked yet." };
  if (health.status === "unconfigured") return { health: "unknown", reason: "No torrent client is configured." };
  if (health.status === "ok") {
    if (health.network === "ok" || health.network === "unknown") return { health: "ok", reason: null };
    return { health: "degraded", reason: health.message };
  }
  return { health: "down", reason: health.message };
}

/** TorBox downloads run remotely; only the local backend depends on the local torrent client. */
const usesLocalTorrentClient = (backend: string | null) => backend !== "torbox";

/**
 * What a download offers and says once it is stuck (#716): Cancel by its status, and the cause's reason for a local
 * download the client was asked about. Retry is not offered here: re-adding a torrent the client has mends nothing,
 * and a torrent the client lost turns the download failed on the queue's next check, which offers Retry.
 */
function stuckFields(row: AcquisitionRow, lookup: TorrentLookup | null) {
  return {
    stuckReason: asksClient(row) ? stuckDownloadReason(lookup, row.hash) : null,
    stuckActions: offeredActions(ACQUISITION_STUCK_ACTIONS, row.status),
  };
}

/** What the source's probe returns: the client's health, and what it says of the local downloads' torrents (#716). */
export type AcquisitionProbe = { health: TorrentHealth; torrents: TorrentLookup | null };

/** Whether Activity asks the client about this download's torrent: a local one that is fetching. */
const asksClient = (row: Pick<AcquisitionRow, "status" | "backend" | "hash">) =>
  usesLocalTorrentClient(row.backend || null) && ACQUISITION_ACTIVITY_STATES[row.status as AcquisitionJobStatus] === "running" && !!row.hash;

/**
 * Whether the work `w` of the download `a` already has a ready recording, one with a track, in an audio edition other
 * than the one the download made (`a.book_id`) (#716). A placeholder edition has no track, so it never counts.
 */
const HAS_OTHER_COPY_SQL = `(w.id IS NOT NULL AND EXISTS(
  SELECT 1 FROM audio_editions copy_e JOIN recordings copy_r ON copy_r.edition_id = copy_e.id
   WHERE copy_e.work_id = w.id AND (a.book_id IS NULL OR copy_e.id <> a.book_id)
     AND EXISTS(SELECT 1 FROM tracks copy_t WHERE copy_t.recording_id = copy_r.id)))`;

export const acquisitionSource = defineSource<AcquisitionRow[], AcquisitionProbe>({
  kind: "acquisition",
  process: { id: "acquisitions", label: "Download queue" },
  stuckAfterMs: 15 * MINUTE,
  load: (sqlite, { userId }) =>
    withWorks(
      sqlite, userId,
      sqlite.prepare(
        `SELECT a.id, a.hash, a.title, a.author, a.backend, a.status, a.progress, a.error, a.cover, a.created_at, a.updated_at,
                w.id AS work_id, ${HAS_OTHER_COPY_SQL} AS has_copy
           FROM acquisitions a LEFT JOIN audio_editions e ON e.id = a.book_id
           LEFT JOIN works w ON w.id = COALESCE(a.work_id, e.work_id)`,
      ).all() as Array<Omit<AcquisitionRow, "work"> & { work_id: string | null }>,
      (row) => row.work_id,
    ),
  async probe(deps, rows) {
    const hashes = [...new Set(rows.filter(asksClient).map((row) => String(row.hash).toLowerCase()))];
    const ask = deps.torrentStates;
    const [health, torrents] = await Promise.all([
      deps.torrentHealth(),
      ask && hashes.length
        ? ask(hashes).then(
          (states): TorrentLookup => ({ states: new Map(states.map((state) => [String(state.hashString).toLowerCase(), state])) }),
          // A `TransmissionError` says whether the client could not be reached; anything else names no cause.
          (error: unknown): TorrentLookup => ({ failure: (error as { failure?: string })?.failure === "unreachable" ? "unreachable" : "other" }),
        )
        : Promise.resolve(null),
    ]);
    return { health, torrents };
  },
  report(rows, probe, { now, tracker }) {
    const drafts = rows.map((row) => {
      const { state, unknown } = stateFrom(ACQUISITION_ACTIVITY_STATES, row.status);
      const id = `acquisition:${row.id}`;
      // A download stored by an older build may hold a sample book's cover: no cover of its own (#763).
      const cover = ownCover(row.cover, row.id);
      const book = itemWork(row.work, cover);
      return {
        id, kind: "acquisition" as const, processId: "acquisitions", title: row.title, detail: row.author || null, user: null,
        state, progress: clamp01(row.progress), host: row.backend || null, startedAt: row.created_at, updatedAt: row.updated_at,
        ...book, cover: book.cover || cover,
        facts: { kind: "acquisition" as const, status: row.status, backend: row.backend || null },
        error: unknown ?? (row.error || null),
        changedAt: state === "running" ? tracker.observe(id, `${row.status}|${row.progress}`, now) : row.updated_at,
        dependsOn: usesLocalTorrentClient(row.backend || null) ? TORRENT_CLIENT.id : null,
        actions: offeredActions(ACQUISITION_ACTIONS, row.status),
        ...stuckFields(row, probe.value?.torrents ?? null),
        // A download still fetching a book that already has a copy (#716): once stuck, not a problem of the book.
        ...(state === "running" && row.has_copy ? { superseded: true } : {}),
      };
    });
    return { drafts, services: [{ ...TORRENT_CLIENT, ...torrentProcessHealth(probe.value?.health ?? null, probe.failure) }] };
  },
  retry: control("retry"),
  resume: control("resume"),
  cancel,
});
