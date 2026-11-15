import {
  existsSync,
  mkdirSync,
  statSync,
  realpathSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
export const mediaRoot = resolve(
  process.env.MEDIA_ROOT || "/mnt/usb_4t_1/sonder",
);
export const torrentDownloadDir =
  process.env.TRANSMISSION_DOWNLOAD_DIR || "/downloads/complete";
export const completedDir = join(mediaRoot, "complete");
export const ebookDir = join(mediaRoot, "ebooks");
export const importedDir = join(mediaRoot, "imports");
/**
 * Why the media drive must not be written now (`REQUIRE_MEDIA_MOUNT`), or null: the recorded volume is missing,
 * Docker runs without a recorded volume, or the media root is on the system disk. Reads only.
 */
export function mediaMountProblem() {
  if (process.env.REQUIRE_MEDIA_MOUNT === "false") return null;
  const marker = join(mediaRoot, ".media-volume");
  const expected = process.env.MEDIA_VOLUME_ID;
  if (
    expected &&
    (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== expected)
  )
    return "The configured media volume is unavailable. Refusing to write media to another disk.";
  if (existsSync("/.dockerenv") && !expected)
    return "Run scripts/setup-local-torrents.mjs to record the media volume before starting Docker.";
  let parent = mediaRoot;
  while (!existsSync(parent) && parent !== dirname(parent))
    parent = dirname(parent);
  if (statSync(parent).dev === statSync("/").dev)
    return `The media drive is not mounted at ${mediaRoot}. Refusing to store media on the system disk.`;
  return null;
}
export function ensureMediaStorage() {
  const problem = mediaMountProblem();
  if (problem) throw new Error(problem);
  for (const dir of [
    mediaRoot,
    completedDir,
    ebookDir,
    importedDir,
    join(mediaRoot, "incomplete"),
    join(mediaRoot, "demo"),
    join(mediaRoot, "saved"),
    join(mediaRoot, "alignment"),
  ])
    mkdirSync(dir, { recursive: true, mode: 0o750 });
  const demo = join(mediaRoot, "demo", "alice-01.mp3");
  if (!existsSync(demo) && existsSync("server/demo/alice-01.mp3"))
    copyFileSync("server/demo/alice-01.mp3", demo);
}
export function resolveTorrentFile(downloadDir: string, name: string) {
  const root = torrentDownloadDir.replace(/\/$/, "");
  if (downloadDir !== root && !downloadDir.startsWith(root + "/"))
    throw new Error("This torrent is outside Sonder’s download directory.");
  const mapped = resolve(completedDir, relative(root, downloadDir), name);
  const rel = relative(completedDir, mapped);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("The torrent contains an unsafe media path.");
  if (existsSync(mapped)) {
    const actual = realpathSync(mapped),
      realRoot = realpathSync(completedDir);
    const actualRel = relative(realRoot, actual);
    if (actualRel.startsWith("..") || isAbsolute(actualRel))
      throw new Error("Media files must remain on the configured drive.");
  }
  return mapped;
}
