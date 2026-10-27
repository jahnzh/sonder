import { closeSync, openSync, readSync } from "node:fs";

// Saved copies can have an extension based on an upstream Content-Type rather
// than their actual bytes. Detect common containers before serving or naming.
export function audioFileMime(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(12);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") return "audio/mp4";
    if (length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
    if (length >= 4 && bytes.toString("ascii", 0, 4) === "fLaC") return "audio/flac";
    if (length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
    if (length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
    if (length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
    return undefined;
  } finally { closeSync(fd); }
}

export function audioFileExtension(type: string | undefined): string {
  return ({ "audio/mp4": ".m4b", "audio/ogg": ".ogg", "audio/flac": ".flac", "audio/wav": ".wav", "audio/mpeg": ".mp3" } as Record<string, string>)[type || ""] || ".mp3";
}

export function isCompleteMediaResponse(response: Response) {
  if (response.status === 200) return true;
  if (response.status !== 206) return false;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get("content-range") || "",
  );
  if (
    !range ||
    Number(range[1]) !== 0 ||
    Number(range[2]) + 1 !== Number(range[3])
  )
    return false;
  const length = response.headers.get("content-length");
  return length === null || Number(length) === Number(range[3]);
}
export function retryDelayFromHeader(value: string | null, fallback = 1000) {
  const seconds = value === null ? NaN : Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value || "") - Date.now();
  return Number.isFinite(milliseconds)
    ? Math.min(60000, Math.max(0, milliseconds))
    : fallback;
}
