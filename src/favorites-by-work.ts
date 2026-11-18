// Favourites by work (#577, spec #572 "The Library": "Favourites by work"). Until this version the device kept the
// favourites as audio edition ids (the `favorites` preference, one id per Library row of `GET /api/books`); the
// Library by work keeps work ids under `workFavorites`. The device database's version 8 maps the one to the other
// once, through the device's `books` table (which holds placeholder editions too); the old preference stays as it
// is, so an older tab keeps its own list until it reloads. Pure apart from the upgrade, which gets its tables.
// A page module: the server imports none of it.

/** The earlier preference: audio edition ids. Read by older builds only. */
export const EDITION_FAVORITES_KEY = "favorites";
/** The favourites by work: work ids. */
export const WORK_FAVORITES_KEY = "workFavorites";

/**
 * Today's favourite edition ids as work ids, through the device's books (`id` is the edition, `workId` its work):
 * placeholders count like any edition, two editions of one work give that work once, an id the device does not
 * know is dropped. In the order of the first edition of each work.
 */
export function migrateFavorites(ids: readonly unknown[], books: readonly { id: string; workId?: string | null }[]): string[] {
  const workOf = new Map(books.flatMap((book) => (book.workId ? [[book.id, book.workId] as const] : [])));
  const works: string[] = [];
  for (const id of ids) {
    const workId = typeof id === "string" ? workOf.get(id) : undefined;
    if (workId && !works.includes(workId)) works.push(workId);
  }
  return works;
}

type Preferences = { get(key: string): Promise<{ key: string; value: unknown } | undefined>; put(row: { key: string; value: unknown }): Promise<unknown> };

/**
 * The upgrade to version 8: writes `workFavorites` from `favorites`. A device that already has favourites by work
 * (the version ran before) keeps them. Nothing else is read or written: places, downloads and position history stay.
 */
export async function upgradeFavoritesToWorks(preferences: Preferences, books: { toArray(): Promise<{ id: string; workId?: string | null }[]> }) {
  if (await preferences.get(WORK_FAVORITES_KEY)) return;
  const old = (await preferences.get(EDITION_FAVORITES_KEY))?.value;
  if (!Array.isArray(old) || old.length === 0) return;
  await preferences.put({ key: WORK_FAVORITES_KEY, value: migrateFavorites(old, await books.toArray()) });
}

/** The Book page's Favorite: the work joins the favourites, or leaves them. */
export function toggleFavoriteWork(workId: string, favorites: readonly string[]): string[] {
  return favorites.includes(workId) ? favorites.filter((id) => id !== workId) : [...favorites, workId];
}
