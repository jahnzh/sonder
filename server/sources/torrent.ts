import { createHash } from "node:crypto";
// Minimal bencode reader: enough to locate the info dictionary and trackers of a .torrent file.
type Value = number | Buffer | Value[] | { [key: string]: Value };
function decode(data: Buffer, start: number, infoRange: number[]) {
  let at = start;
  const read = (depth: number, key?: string): Value => {
    if (depth > 64) throw new Error("This torrent file is nested too deeply.");
    const begin = at;
    const char = data[at];
    if (char === 0x69) {
      const end = data.indexOf(0x65, at);
      if (end < 0) throw new Error("This torrent file is truncated.");
      const value = Number(data.subarray(at + 1, end).toString("ascii"));
      at = end + 1;
      return value;
    }
    if (char === 0x6c || char === 0x64) {
      at++;
      const list: Value[] = [];
      const dict: Record<string, Value> = {};
      while (data[at] !== 0x65) {
        if (at >= data.length) throw new Error("This torrent file is truncated.");
        if (char === 0x6c) list.push(read(depth + 1));
        else {
          const name = read(depth + 1);
          if (!Buffer.isBuffer(name))
            throw new Error("This torrent file has an invalid dictionary.");
          const field = name.toString("latin1");
          dict[field] = read(depth + 1, depth === 0 ? field : undefined);
        }
      }
      at++;
      if (key === "info") infoRange.push(begin, at);
      return char === 0x6c ? list : dict;
    }
    const colon = data.indexOf(0x3a, at);
    const length = Number(data.subarray(at, colon).toString("ascii"));
    if (colon < 0 || !Number.isInteger(length) || length < 0)
      throw new Error("This is not a valid torrent file.");
    const end = colon + 1 + length;
    if (end > data.length) throw new Error("This torrent file is truncated.");
    at = end;
    return data.subarray(colon + 1, end);
  };
  return read(0);
}
export function torrentToMagnet(data: Buffer) {
  const infoRange: number[] = [];
  const root = decode(data, 0, infoRange);
  if (!root || typeof root !== "object" || Array.isArray(root) || Buffer.isBuffer(root) || infoRange.length !== 2)
    throw new Error("This torrent file has no info section.");
  const hash = createHash("sha1")
    .update(data.subarray(infoRange[0], infoRange[1]))
    .digest("hex");
  const info = root.info as Record<string, Value>;
  const params = new URLSearchParams({ xt: `urn:btih:${hash}` });
  if (Buffer.isBuffer(info.name)) params.set("dn", info.name.toString("utf8"));
  const trackers = new Set<string>();
  if (Buffer.isBuffer(root.announce)) trackers.add(root.announce.toString("utf8"));
  if (Array.isArray(root["announce-list"]))
    for (const tier of root["announce-list"])
      if (Array.isArray(tier))
        for (const url of tier)
          if (Buffer.isBuffer(url)) trackers.add(url.toString("utf8"));
  for (const tracker of [...trackers].slice(0, 30))
    if (/^(udp|https?|wss?):\/\//i.test(tracker)) params.append("tr", tracker);
  return { hash, magnet: `magnet:?${params.toString().replaceAll("%3A", ":")}` };
}

/**
 * What a `.torrent` file says of itself (#911): its info hash, its name (the file or folder it makes in the download
 * folder) and whether it is a private tracker's (`info.private` 1). The announce address (a private tracker's carries
 * the member's passkey) is not returned.
 */
export function torrentFacts(data: Buffer) {
  const infoRange: number[] = [];
  const root = decode(data, 0, infoRange);
  if (!root || typeof root !== "object" || Array.isArray(root) || Buffer.isBuffer(root) || infoRange.length !== 2)
    throw new Error("This torrent file has no info section.");
  const info = root.info as Record<string, Value>;
  if (!info || typeof info !== "object" || Array.isArray(info) || Buffer.isBuffer(info) || !Buffer.isBuffer(info.name))
    throw new Error("This torrent file has no name.");
  const name = info.name.toString("utf8");
  // A name that would leave the download folder is no torrent Sonder adds.
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) throw new Error("This torrent file has an invalid name.");
  const hash = createHash("sha1").update(data.subarray(infoRange[0], infoRange[1])).digest("hex");
  return { hash, name, private: info.private === 1 };
}
