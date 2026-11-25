export type TorrentFile = {
  name: string;
  length: number;
  bytesCompleted: number;
};
export type LocalTorrent = {
  id: number;
  hashString: string;
  name: string;
  downloadDir: string;
  percentDone: number;
  status: number;
  rateDownload: number;
  eta: number;
  error: number;
  errorString: string;
  files: TorrentFile[];
  fileStats: { bytesCompleted: number; wanted: boolean }[];
};
let sessionId = "";
export type TransmissionFailure =
  | "unconfigured"
  | "unreachable"
  | "auth"
  | "http"
  | "rpc"
  | "session";
export class TransmissionError extends Error {
  constructor(
    message: string,
    readonly failure: TransmissionFailure,
  ) {
    super(message);
  }
}
export function transmissionConfigured() {
  return !!process.env.TRANSMISSION_RPC_URL;
}
export async function transmission<T = Record<string, unknown>>(
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15000,
): Promise<T> {
  const url = process.env.TRANSMISSION_RPC_URL;
  if (!url)
    throw new TransmissionError(
      "The local torrent client is not configured. Run the local torrent setup script on your server.",
      "unconfigured",
    );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (process.env.TRANSMISSION_USERNAME)
    headers.Authorization =
      "Basic " +
      Buffer.from(
        `${process.env.TRANSMISSION_USERNAME}:${process.env.TRANSMISSION_PASSWORD || ""}`,
      ).toString("base64");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (sessionId) headers["X-Transmission-Session-Id"] = sessionId;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, arguments: args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new TransmissionError(
        "The local torrent client cannot be reached. Check that the torrent and VPN containers are running.",
        "unreachable",
      );
    }
    if (response.status === 409) {
      sessionId = response.headers.get("X-Transmission-Session-Id") || "";
      continue;
    }
    if (response.status === 401)
      throw new TransmissionError(
        "The local torrent client rejected its credentials.",
        "auth",
      );
    if (!response.ok)
      throw new TransmissionError(
        `The local torrent client returned ${response.status}.`,
        "http",
      );
    const body = (await response.json()) as { result: string; arguments: T };
    if (body.result !== "success")
      throw new TransmissionError(`Local torrent client: ${body.result}`, "rpc");
    return body.arguments;
  }
  throw new TransmissionError(
    "Could not negotiate a session with the local torrent client.",
    "session",
  );
}
export async function getTorrent(hash: string) {
  const result = await transmission<{ torrents: LocalTorrent[] }>(
    "torrent-get",
    {
      ids: [hash],
      fields: [
        "id",
        "hashString",
        "name",
        "downloadDir",
        "percentDone",
        "status",
        "rateDownload",
        "eta",
        "error",
        "errorString",
        "files",
        "fileStats",
      ],
    },
  );
  return result.torrents[0] || null;
}
/**
 * Add a torrent by its magnet link, or by a `.torrent` file's bytes (`metainfo`: a private tracker's own file, #911,
 * whose announce address carries the member's passkey and is never written anywhere else).
 */
export async function addTorrent(magnet: string, downloadDir: string, options: { metainfo?: Buffer } = {}) {
  const result = await transmission<{
    "torrent-added"?: { hashString: string; id: number; name: string };
    "torrent-duplicate"?: { hashString: string; id: number; name: string };
  }>("torrent-add", {
    ...(options.metainfo ? { metainfo: options.metainfo.toString("base64") } : { filename: magnet }),
    "download-dir": downloadDir,
    labels: options.metainfo ? ["sonder", "mam"] : ["sonder"],
    paused: false,
  });
  const torrent = result["torrent-added"] || result["torrent-duplicate"];
  if (!torrent) throw new Error("Transmission did not return a torrent.");
  return torrent;
}

/**
 * A private tracker's torrent seeds on (#911): no ratio limit and no idle limit stop it (Transmission's `seedRatioMode`
 * and `seedIdleMode` 2, "unlimited", whatever the client's own settings say).
 */
export async function keepSeeding(hash: string, call: typeof transmission = transmission) {
  await call("torrent-set", { ids: [hash], seedRatioMode: 2, seedIdleMode: 2 });
}

/** What Activity shows of a seeding torrent (#911): its status, how far it is, how long it has seeded and its ratio. */
export type SeedingState = {
  hashString: string;
  status: number;
  percentDone: number;
  /** Seconds the torrent has seeded in all, as Transmission counts them (over restarts of the client). */
  secondsSeeding: number;
  /** Uploaded over downloaded; Transmission answers -1 when nothing was downloaded, -2 for an infinite ratio. */
  uploadRatio: number;
  uploadedEver: number;
  error: number;
  errorString: string;
};

export async function getSeedingStates(hashes: string[], timeoutMs = 5000) {
  if (!hashes.length) return [] as SeedingState[];
  const result = await transmission<{ torrents: SeedingState[] }>(
    "torrent-get",
    { ids: hashes, fields: ["hashString", "status", "percentDone", "secondsSeeding", "uploadRatio", "uploadedEver", "error", "errorString"] },
    timeoutMs,
  );
  return result.torrents ?? [];
}

/**
 * What Transmission says of a torrent that does not move (#716): its error, whether it has its metadata, and its peers.
 * Field names as the RPC answers `torrent-get` (`error` 1 tracker warning, 2 tracker error, 3 local error).
 */
export type TorrentState = {
  hashString: string;
  status: number;
  error: number;
  errorString: string;
  percentDone: number;
  metadataPercentComplete: number;
  peersConnected: number;
  peersSendingToUs: number;
  trackerStats?: { seederCount: number; lastAnnounceSucceeded?: boolean; lastAnnounceResult?: string }[];
};

/** The states of the torrents with these hashes; a hash the client does not have is absent from the answer. */
export async function getTorrentStates(hashes: string[], timeoutMs = 3000) {
  if (!hashes.length) return [] as TorrentState[];
  const result = await transmission<{ torrents: TorrentState[] }>(
    "torrent-get",
    {
      ids: hashes,
      fields: [
        "hashString",
        "status",
        "error",
        "errorString",
        "percentDone",
        "metadataPercentComplete",
        "peersConnected",
        "peersSendingToUs",
        "trackerStats",
      ],
    },
    timeoutMs,
  );
  return result.torrents ?? [];
}

/** Stop and remove a torrent with its partial data; a hash the client does not have is no error to Transmission. */
export async function removeTorrent(hash: string) {
  await transmission("torrent-remove", { ids: [hash], "delete-local-data": true });
}
