import type { LibraryWork } from '../types';
import { workProgress } from '../work-progress';

export function filterLibrary(works: LibraryWork[], chip: string, query: string, favorites: readonly string[], onDevice: ReadonlySet<string>, shelf: string, list: string): LibraryWork[] {
  const term = query.trim().toLocaleLowerCase();
  return works.filter((work) => {
    const state = workProgress(work);
    return (!term || `${work.title} ${work.author}`.toLocaleLowerCase().includes(term)) &&
      (chip === 'All books' || chip === 'Series' ||
       (chip === 'In progress' && state === 'in-progress') ||
       (chip === 'Not started' && state === 'not-started') ||
       (chip === 'Finished' && state === 'finished') ||
       (chip === 'On device' && onDevice.has(work.workId)) ||
       (chip === 'Favorites' && favorites.includes(work.workId))) &&
      (shelf === 'all' || (shelf === 'linked' ? !!work.hardcover : work.hardcover?.statusId === Number(shelf))) &&
      (list === 'all' || work.hardcover?.listIds.includes(Number(list)));
  });
}
export function migrateFavorites(ids: readonly string[], books: readonly {id: string; workId: string}[]): string[] {
  const byId = new Map(books.map((book) => [book.id, book.workId]));
  return [...new Set(ids.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []))];
}
export function latestPlace(work: LibraryWork): number {
  return Math.max(0, ...work.recordings.map((r) => r.progress?.updatedAt ?? 0), ...work.ebooks.map((e) => e.place?.updatedAt ?? 0));
}

/** Highest current fraction of any individual place; recordings are never combined. */
export function progressFraction(work: LibraryWork): number {
  const audio = work.recordings.map((recording) => {
    const place = recording.progress;
    if (!place) return 0;
    const index = recording.tracks.findIndex((track) => track.id === place.trackId);
    const total = recording.tracks.reduce((sum, track) => sum + track.duration, 0);
    return index < 0 || total <= 0 ? 0 : (recording.tracks.slice(0, index).reduce((sum, track) => sum + track.duration, 0) + place.position) / total;
  });
  return Math.max(workProgress(work) === 'finished' ? 1 : 0, ...audio, ...work.ebooks.map((ebook) => ebook.place?.progression ?? 0));
}
