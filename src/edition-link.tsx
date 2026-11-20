// An old reader link (`#reader/<ebook id>`, spec #608 "Old names", #613 part 2): the reader on its own is gone, so
// the link opens Now playing's Read face of the ebook's book with that edition (#596). The routes module reads the
// link as the Library with the edition to look up; this asks the reader's loader for the edition's work and moves
// the link's entry there, in place. An ebook that is gone leaves the Library in the link's place.
import { useEffect } from "react";
import { ApiError, api, localDB } from "./lib";
import { dropEditionLink, followEditionLink, shownEditionLink, useAddress } from "./navigation";
import { editionRoute } from "./routes";
import type { ReaderBook } from "./reading-types";
import { setDeviceEbookChoice } from "./ebook-device-copy";

/** The words when an old reader link names an ebook that is gone (unchanged from the reader on its own). */
export const EDITION_GONE = "That ebook is no longer in your library.";

/**
 * The edition's work, from the reader's loader (`GET /api/reader/<id>`). The server's "not found" is final (the
 * ebook is gone, even with its details still kept here); offline, the details the reader kept on this device name it.
 */
export async function editionWork(ebookId: string): Promise<{ workId?: string } | null> {
  try {
    return await api<Pick<ReaderBook, "workId">>(`/reader/${encodeURIComponent(ebookId)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    const kept = (await localDB.preferences.get(`reader-book:${ebookId}`))?.value as Pick<ReaderBook, "workId"> | undefined;
    if (kept?.workId) return kept;
    throw error;
  }
}

export function EditionLinkFollower({ notify }: { notify: (text: string, error?: boolean) => void }) {
  // Renders again on every move, so a link reached by Back or typed later is followed too.
  useAddress();
  const link = shownEditionLink();
  const key = link?.key ?? null;
  const ebookId = link?.ebookId ?? null;
  useEffect(() => {
    if (!key || !ebookId) return;
    const still = () => shownEditionLink()?.key === key;
    editionWork(ebookId).then(
      (book) => {
        const route = editionRoute(book);
        if (!still()) return;
        if (!route) {
          dropEditionLink(key);
          return notify(EDITION_GONE, true);
        }
        // "With that edition": this device's choice of edition for the work, which the Read face opens (a shared
        // default the administrator set still wins, as on the Book page's Read).
        setDeviceEbookChoice(route.workId, ebookId);
        followEditionLink(key, route);
      },
      (error: unknown) => {
        if (!still()) return;
        dropEditionLink(key);
        // Offline with nothing kept here: the Library stays, and the message says what failed.
        notify((error as Error).message, true);
      },
    );
  }, [key, ebookId]);
  return null;
}
