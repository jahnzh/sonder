// Match chapter identities before removing numbers for descriptive title matching.
// An ebook heading "1" and an audio heading "Chapter 1" name the same region.
const roman = /^(?=.+)m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
function number(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  if (!roman.test(value)) return null;
  const values: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  };
  return [...value].reduce(
    (total, char, i) =>
      total +
      (values[char] < (values[value[i + 1]] || 0)
        ? -values[char]
        : values[char]),
    0,
  );
}
function chapter(title: string) {
  const text = title
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\.(mp3|m4b|m4a|ogg|opus|flac|wav|aac)$/, "");
  const explicit = /\bchapter\s*[-.:]?\s*(\d+|[ivxlcdm]+)\b/.exec(text);
  const bare = /^(\d+|[ivxlcdm]+)(?:$|\s*[-.:–—]\s*.+$)/.exec(text);
  const token = explicit?.[1] || bare?.[1];
  if (!token) return null;
  const value = number(token);
  if (value === null) return null;
  const part = /\bpart\s+(\d+|[ivxlcdm]+)\b/.exec(text);
  return { value, part: part ? number(part[1]) : null };
}
const norm = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\b(chapter|part|section)\b|\b[ivxlcdm]+\b|\d+/g, " ")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function matchTitle(a: string, b: string) {
  const first = chapter(a),
    second = chapter(b);
  if (first && second) {
    if (
      first.value !== second.value ||
      (first.part !== null &&
        second.part !== null &&
        first.part !== second.part)
    )
      return 0;
    return 1;
  }
  const x = norm(a),
    y = norm(b);
  if (x && x === y) return 1;
  const words = x.split(" ").filter((word) => word.length > 2),
    other = new Set(y.split(" "));
  return words.length
    ? words.filter((word) => other.has(word)).length /
        Math.max(words.length, other.size)
    : 0;
}
type Section = { index: number; title: string };
type Clip = { trackId: string; title: string; start: number; duration: number };
export function matchSections(sections: Section[], clips: Clip[]) {
  const positional =
    sections.length === clips.length &&
    clips.every((clip) =>
      /^(?:track|file|audio)\s*\d+(?:\.(?:mp3|m4b|m4a|ogg|opus|flac|wav|aac))?$/i.test(
        clip.title.trim(),
      ),
    );
  const used = new Set<number>(),
    pairings: {
      section: number;
      trackId: string;
      start: number;
      duration: number;
    }[] = [];
  for (const [sectionIndex, section] of sections.entries()) {
    if (
      /^(?:part|book|volume|section)\b/i.test(section.title) &&
      !/\bchapter\b/i.test(section.title)
    )
      continue;
    const scores = clips
      .map((clip, index) => ({
        index,
        score: matchTitle(section.title, clip.title),
      }))
      .sort((a, b) => b.score - a.score);
    let index = -1;
    if (scores[0]?.score >= 0.45) {
      // Repeated chapter numbers across parts need an explicit section match.
      if (scores[1]?.score !== scores[0].score || !chapter(section.title))
        index = scores[0].index;
    } else if (positional) {
      const a = chapter(section.title),
        b = chapter(clips[sectionIndex].title);
      if (!a || !b || a.value === b.value) index = sectionIndex;
    }
    if (index < 0 || used.has(index)) continue;
    const clip = clips[index];
    if (clip.duration <= 0 || clip.duration > 7200) continue;
    used.add(index);
    pairings.push({
      section: section.index,
      trackId: clip.trackId,
      start: clip.start,
      duration: clip.duration,
    });
  }
  return pairings;
}
