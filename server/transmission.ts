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
export function transmissionConfigured() {
  return !!process.env.TRANSMISSION_RPC_URL;
}
export async function transmission<T = Record<string, unknown>>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const url = process.env.TRANSMISSION_RPC_URL;
  if (!url)
    throw new Error(
      "The local torrent client is not configured. Run the local torrent setup script on your server.",
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
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(
        "The local torrent client cannot be reached. Check that the torrent and VPN containers are running.",
      );
    }
    if (response.status === 409) {
      sessionId = response.headers.get("X-Transmission-Session-Id") || "";
      continue;
    }
    if (response.status === 401)
      throw new Error("The local torrent client rejected its credentials.");
    if (!response.ok)
      throw new Error(`The local torrent client returned ${response.status}.`);
    const body = (await response.json()) as { result: string; arguments: T };
    if (body.result !== "success")
      throw new Error(`Local torrent client: ${body.result}`);
    return body.arguments;
  }
  throw new Error(
    "Could not negotiate a session with the local torrent client.",
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
export async function addTorrent(magnet: string, downloadDir: string) {
  const result = await transmission<{
    "torrent-added"?: { hashString: string; id: number; name: string };
    "torrent-duplicate"?: { hashString: string; id: number; name: string };
  }>("torrent-add", {
    filename: magnet,
    "download-dir": downloadDir,
    labels: ["sonder"],
    paused: false,
  });
  const torrent = result["torrent-added"] || result["torrent-duplicate"];
  if (!torrent) throw new Error("Transmission did not return a torrent.");
  return torrent;
}
