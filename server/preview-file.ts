// Which file of a release a preview plays (#889). Pure: no database, no TorBox.

/** The audio files Get takes from a release; anything else in it is never played. */
export const audioPattern = /\.(m4b|m4a|mp3|ogg|flac|opus|wav)$/i;

/** Get's order of a release's tracks: by name, with the numbers in them in order ("2" before "10"). */
export function byTrackName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

/** A file this small is a jingle or a credits file, not the reading. */
export const PREVIEW_MIN_BYTES = 3 * 1024 * 1024;

/**
 * Names that are not the reading itself, as whole words ("Introvert" is a reading; "01 - Intro" is not). Digits,
 * spaces, dashes, dots and underscores separate words in file names.
 */
const notTheReading = /(?:^|[^a-z])(?:credits|intro|introduction|preface|foreword|sample|epilogue|afterword|outro)(?:$|[^a-z])/i;

export type ReleaseFile = { id: number; name: string; size?: number | null };

/**
 * The file a preview plays, by this rule in order: the release's audio files only (none: null, there is nothing to
 * preview); sorted by name with numbers in order, as Get orders tracks; without files under 3 MB and without files
 * whose name has the word credits, intro, introduction, preface, foreword, sample, epilogue, afterword or outro (if none is left, the
 * largest audio file); the first of those. A file whose size TorBox does not give is not counted as small.
 */
export function previewFile<T extends ReleaseFile>(files: readonly T[]): T | null {
  const audio = files.filter((file) => audioPattern.test(file.name)).sort(byTrackName);
  if (!audio.length) return null;
  const reading = audio.filter((file) => {
    const small = typeof file.size === "number" && file.size < PREVIEW_MIN_BYTES;
    const base = file.name.split("/").pop() ?? file.name;
    return !small && !notTheReading.test(base);
  });
  if (reading.length) return reading[0];
  return audio.reduce((largest, file) => ((file.size ?? 0) > (largest.size ?? 0) ? file : largest));
}
