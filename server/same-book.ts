// The same book under two spellings (moved out of Hardcover's module, #721): title and author compared with case,
// accents, punctuation and a leading article ignored, the author's names in any order. "Unknown author" matches nothing.
import { sqlite } from "./db.ts";

function normalized(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}
export function sameBook(
  a: { title: string; author: string },
  b: { title: string; author: string },
) {
  const names = (v: string) => normalized(v).split(" ").sort().join(" ");
  return (
    normalized(a.title) === normalized(b.title) &&
    a.author !== "Unknown author" &&
    b.author !== "Unknown author" &&
    names(a.author) === names(b.author)
  );
}

/**
 * The matched work new media of `title` by `author` joins when it names no work: the one work with that title and
 * author that is matched to a catalogue book (`work_catalogue_links`) or was matched to Hardcover before its removal
 * (the kept `hardcover_links`); none when there are several or none.
 */
export function matchedWorkForMedia(title: string, author: string) {
  const works = sqlite
    .prepare(
      `SELECT id,title,author FROM works
       WHERE id IN (SELECT work_id FROM work_catalogue_links) OR id IN (SELECT work_id FROM hardcover_links)`,
    )
    .all() as { id: string; title: string; author: string }[];
  const matches = works.filter((work) => sameBook(work, { title, author }));
  return matches.length === 1 ? matches[0].id : undefined;
}
