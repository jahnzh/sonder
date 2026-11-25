// The split of a series pack into its books (ADR 0027, #899). Pure: it reads only the file list it is given.
import { bareVolumeTitle, normalizeSeriesAudioTitle } from "./series-audio.ts";

/** One audio file of a pack: its key (TorBox's file id, or its index in the torrent) and its name in the torrent. */
export type PackFile = { key: string; name: string };
export type PackVolume = { position: number; title: string };

/**
 * A unit of a pack: a folder below the folder every file shares (with every file under it), or a file directly in
 * that folder. `position` is the volume its name was read as; null when it names none, or two that disagree.
 */
export type PackUnit = { key: string; label: string; files: string[]; position: number | null };

export type PackSplit = {
  units: PackUnit[];
  /** The files of each volume the split is certain of, in natural order. A volume it is not certain of is absent. */
  books: Map<number, string[]>;
};

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const withoutExtension = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "");

/** The units of a pack's files (see `PackUnit`), in natural order of their labels. */
export function packUnits(files: readonly PackFile[]): Omit<PackUnit, "position">[] {
  const paths = files.map((file) => file.name.split("/").filter(Boolean));
  // The folders every file shares; a pack of one file has only that file's folder.
  let shared = paths.length ? paths[0].length - 1 : 0;
  for (const parts of paths) {
    let same = 0;
    while (same < shared && same < parts.length - 1 && parts[same] === paths[0][same]) same++;
    shared = same;
  }
  const units = new Map<string, { label: string; files: { key: string; name: string }[] }>();
  files.forEach((file, index) => {
    const rest = paths[index].slice(shared);
    const folder = rest.length > 1;
    const key = folder ? `${paths[index].slice(0, shared + 1).join("/")}/` : file.name;
    const label = folder ? rest[0] : withoutExtension(rest[0] ?? file.name);
    const unit = units.get(key) ?? { label, files: [] };
    unit.files.push({ key: file.key, name: file.name });
    units.set(key, unit);
  });
  return [...units.entries()]
    .map(([key, unit]) => ({ key, label: unit.label, files: unit.files.sort((a, b) => natural(a.name, b.name)).map((file) => file.key) }))
    .sort((a, b) => natural(a.label, b.label));
}

const NAMED_NUMBER = /\b(?:book|bk|vol|volume)\s*0*(\d{1,3})\b/;
const HASH_NUMBER = /#\s*0*(\d{1,3})\b/;
const LEADING_NUMBER = /^0*(\d{1,3})\b/;

/** A volume's title as the split reads it: without the series' name, and not when it is only the series' name. */
function titleKeys(volumes: readonly PackVolume[], seriesName: string) {
  const seriesKey = normalizeSeriesAudioTitle(seriesName);
  return volumes
    .map((volume) => ({ position: volume.position, key: bareVolumeTitle(volume.title, seriesName) }))
    .filter((volume) => volume.key.length >= 3 && volume.key !== seriesKey);
}

/**
 * The volume a unit's name reads as: the longest volume title it holds as whole words, else a named number
 * ("Book 3", "Vol 3", "#3"), else (when `leading`) a number at its start once the series' name is taken out; a name
 * that is only the series' name, the volume titled so. A name whose title and named number disagree, or that holds
 * two titles of the same length, reads as none.
 */
export function readUnitVolume(
  label: string,
  volumes: readonly PackVolume[],
  seriesName: string,
  leading: boolean,
): number | null {
  const seriesKey = normalizeSeriesAudioTitle(seriesName);
  const normalized = ` ${normalizeSeriesAudioTitle(label)} `;
  const rest = (seriesKey ? normalized.replace(` ${seriesKey} `, " ") : normalized).trim();
  const known = new Set(volumes.map((volume) => volume.position));
  // A name that is only the series' name is the volume titled so (often the first).
  if (!rest)
    return volumes.find((volume) => normalizeSeriesAudioTitle(volume.title) === seriesKey || bareVolumeTitle(volume.title, seriesName) === seriesKey)?.position ?? null;
  const hits = titleKeys(volumes, seriesName)
    .filter((volume) => ` ${rest} `.includes(` ${volume.key} `))
    .sort((a, b) => b.key.length - a.key.length);
  const byTitle =
    hits.length && !(hits.length > 1 && hits[1].key.length === hits[0].key.length && hits[1].position !== hits[0].position)
      ? hits[0].position
      : null;
  if (hits.length && byTitle === null) return null;
  const named = NAMED_NUMBER.exec(rest) ?? HASH_NUMBER.exec(label);
  const byName = named && known.has(Number(named[1])) ? Number(named[1]) : null;
  if (byTitle !== null) return byName === null || byName === byTitle ? byTitle : null;
  if (byName !== null) return byName;
  // A number at the start ("03 - …") counts only without a title, as it may be a track's number.
  const first = leading ? LEADING_NUMBER.exec(rest) : null;
  return first && known.has(Number(first[1])) ? Number(first[1]) : null;
}

/**
 * Split a pack's audio files into the volumes it covers (ADR 0027): each unit is read for its volume by title, then
 * by number; only when no unit names a volume and there are exactly as many units as volumes, by order. A unit that
 * reads as no volume is left out; a volume no unit reads as is not in `books`.
 */
export function splitPack(files: readonly PackFile[], volumes: readonly PackVolume[], seriesName: string): PackSplit {
  const bare = packUnits(files);
  const sorted = [...volumes].sort((a, b) => a.position - b.position);
  // A bare leading number is a book's only while there are no more units than books: 01…40 are a book's tracks.
  const leading = bare.length <= sorted.length;
  let units: PackUnit[] = bare.map((unit) => ({ ...unit, position: readUnitVolume(unit.label, sorted, seriesName, leading) }));
  if (units.every((unit) => unit.position === null) && units.length === sorted.length && units.length > 1)
    units = units.map((unit, index) => ({ ...unit, position: sorted[index].position }));
  const books = new Map<number, string[]>();
  for (const unit of units) {
    if (unit.position === null) continue;
    books.set(unit.position, [...(books.get(unit.position) ?? []), ...unit.files]);
  }
  const order = new Map(files.map((file) => [file.key, file.name]));
  for (const [position, keys] of books) books.set(position, keys.sort((a, b) => natural(order.get(a) ?? a, order.get(b) ?? b)));
  return { units, books };
}
