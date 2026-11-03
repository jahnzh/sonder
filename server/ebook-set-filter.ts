import { sameBook } from "./hardcover.ts";

function normalized(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

function tokens(value: string) {
  return normalized(value).split(" ").filter((t) => t.length > 2);
}

/** Cheap title/author gate before downloading a LibGen hit into the ebook set. */
export function cheapTitleAuthorMatch(
  work: { title: string; author: string },
  candidate: { title: string; authors: string[] },
) {
  if (sameBook(work, { title: candidate.title, author: candidate.authors[0] || "" }))
    return true;
  const wt = normalized(work.title);
  const ct = normalized(candidate.title);
  if (!wt || !ct) return false;
  const workTokens = tokens(work.title);
  const titleTokens = tokens(candidate.title);
  const overlap = workTokens.filter((t) => titleTokens.includes(t)).length;
  if (overlap < Math.min(2, workTokens.length)) return false;
  const authorTokens = new Set(
    candidate.authors.flatMap((name) => tokens(name)),
  );
  return tokens(work.author).some((t) => authorTokens.has(t));
}
