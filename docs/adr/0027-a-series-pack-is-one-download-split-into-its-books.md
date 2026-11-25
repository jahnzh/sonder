# A series pack is one download split into its books

A release such as "Dungeon Crawler Carl Books 1-8 · M4B" holds several books of one series in one torrent. Until now an acquisition belonged to one work, so such a pack became one recording of the first book holding every book's files, and the series queue never picked one (#899). Decision, made for the owner on 2026-11-25: one download can serve several books, each book gets its own recording of only its own files, and the files are never copied.

## The tables

Two additive tables, in `server/db.ts` and `server/schema.ts`:

- **`acquisition_packs`**, one row per acquisition that is a pack: the series (`series_id`, `series_name`), the volumes the pack covers (`volumes`, JSON `[{position, title}]`, from its title's range), and, once its files are known, the pack's audio files (`files`, JSON `[{key, name, path}]`: the TorBox file id or the file's index as `key`, its name in the torrent, and for a local torrent the absolute path).
- **`acquisition_works`**, one row per book the pack serves: `acquisition_id`, `work_id`, the book's `position` and `title`, its `cover`, its `status` (`waiting` until it is split, `ready` once it has its recording, `choose` when the split was not certain), the `files` (JSON list of keys) it was given and the `book_id` (audio edition) made from them.

`acquisitions.work_id` stays one of the pack's works (the one it was chosen for), so Activity and every older reader still find a work; `acquisition_works` is what says which works a pack serves. A work's media state (ADR 0011) reads the acquisitions of a work from `acquisition_works` for a pack and from `acquisitions.work_id` for any other acquisition, so each book of a pack on its way is queued and each one split is available.

## The split

At import (TorBox's `download_present`, or the local torrent at 100 %), `splitPack` (`server/series-pack.ts`, pure) cuts the pack's audio files into **units**: below the folder all files share, a file in a subfolder belongs to the unit of its first folder ("Book 03 - …/CD1/01.mp3" is the unit "Book 03 - …"), a file directly there is a unit of its own. Each unit's name is read for its volume:

1. **By title**: the longest volume title of the pack (without the series' name) that the name contains as whole words. A title that is just the series' name is not read.
2. **By number**: "Book 3", "Vol. 3", "#3", or a number at the start of the name once the series' name is taken out ("Dungeon Crawler Carl 03 - …"). The bare leading number is trusted only when the pack has no more units than volumes, so a flat folder of track files numbered 01 to 40 is not read as books.
3. A name whose title and named number disagree is no book's; a bare leading number never overrules a title (it may be a track's). A name that is only the series' name is the volume titled so.
4. **By order**: only when no unit names any volume and there are exactly as many units as the pack covers volumes, the units in natural order are the volumes in order.

A unit that matches no book is left out. A book with at least one unit gets every file of its units, in natural order, and its recording. A book that got none is not assigned (`choose`): the Get audiobook sheet of that book then lists the pack's units, and the owner chooses which are the book's (`POST /api/works/:id/pack`), which makes its recording the same way.

## Choosing a pack

- **The series queue** (`runAudioJob`) asks, before a book's own search, `seriesPackStep` (`server/acquisition-packs.ts`):
  1. **Sharing**: a pack that covers the book's position, on its way or done (not failed or cancelled), takes the book: no search and no second download. A done pack makes the book's recording at once from its stored file list.
  2. **A pack search**, once per series and user every six hours, when at least two books of the series still wait for audio (their audio search pending or running, no playable audio, released). A candidate is a pack when its title names the series and a range of books (`packCoverage`, `server/series-audio.ts`; "Books 1-8", "#1-3", "Vol 1 to 3"), and is not in another language by #897's rule (`candidateLanguageFits`: a pack whose source or title names another language is never taken; one that names none is, since a pack has no one narrator or length to prove its edition). The one that covers the most waiting books wins, then TorBox's cached copy, then the per-book ranking. A pack is taken only when it covers two waiting books or more; it is acquired for every waiting book it covers, and their searches are marked done. Books with audio are never in it; a book it does not cover keeps its own search.
- **The Get audiobook sheet** asks the server which of its rows are packs of a series the book belongs to (`POST /api/works/:id/packs/describe`) and, for a chosen pack, says which books it holds and which other books without audio it also gets. Get sends `pack: true` with the add; the server makes the acquisition a pack for the book and the other saved books of that series in its range without playable audio. An older client sends no `pack` and gets the download as before.

A title without a range ("Complete Series", "Box Set") is not taken as a pack: what it covers cannot be told before its files are known.

## Removing a book

Removing a book of a series (`series-removal.ts`) removes its recording and its `acquisition_works` row only. Its files, and every other file of the pack, stay on disk while another book of the pack has a recording or still waits for one: the torrent keeps its files whole. When the last book of the pack is removed, every audio file of the pack goes with it (those of the books removed before too), unless a recording or a server copy still points at one. A pack on its way is cancelled only when its last book is removed. When the removed book was the acquisition's `work_id`, another book of the pack takes its place.

## Considered options

- **One recording holding the whole pack** (today's). Refused: progress is per recording, and every book must keep its own position.
- **Copying each book's files out of the pack.** Refused by the owner: twice the space, and the torrent keeps seeding from its own files.
- **Selecting only the wanted files in Transmission** (`files-unwanted`). Left for later: it is an optimisation, and a book wanted later would need the files back.
- **Splitting when the pack is chosen.** The file list of a magnet is unknown until the torrent's metadata arrives; it is complete at import.

## Consequences

- A local pack is imported when the whole torrent is downloaded, not book by book.
- Activity shows a pack once, under the book it was chosen for.
- Files of the pack that are not audio stay on disk after the last book is removed, as a torrent's other files do today.
- Issue: #899.
