// The multi-user check's placeholder rule (#617), shared by scripts/verify-multi-user.mjs (live) and its unit test.
// A placeholder is an audio edition whose recordings have no track (#483, server/placeholder-edition.ts): in
// `GET /api/books` a row with no `tracks`. The rule never reads the id, so it holds for `hc-*`, `placeholder-*`
// (an ebook-only book, #555) and whatever id a later placeholder gets.
// Keep side-effect free: importing this module must not launch a browser or reach a server.

/** @typedef {{ id: string, title?: string, tracks?: unknown[] | null }} BookRow */

/** @param {BookRow} book */
export function isPlaceholder(book) {
  return !book.tracks?.length;
}

/**
 * The placeholders in a fresh account's `GET /api/books`. The check's QA user is created for the run and owns
 * nothing, so every placeholder it sees is someone else's (the administrator's): each one is a leak.
 * @param {BookRow[]} userBooks
 */
export function leakedPlaceholders(userBooks) {
  return userBooks.filter(isPlaceholder);
}

/** @param {BookRow[]} userBooks */
export function assertNoLeakedPlaceholders(userBooks) {
  const leaked = leakedPlaceholders(userBooks);
  if (leaked.length)
    throw new Error("The administrator's placeholders are visible to a user: " + leaked.map((b) => `${b.title ?? ""} (${b.id})`).join(", "));
}
