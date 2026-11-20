# The server prepares the book's text; the sentence ids stay

The server already cuts every EPUB into numbered sentences (`extractBook` in `server/reader.ts`). Alignment maps, reading places, bookmarks, search and the ebook-set consensus all name a sentence by that id. The reader does not use the cut for drawing: it downloads the whole EPUB, lets epub.js lay it out in a frame, and then finds the server's sentences again inside that layout to highlight, follow and save a place. That second half is `src/components/Reader.tsx` (1,866 lines) and about 1,600 lines of helper modules, and it is what makes the reader slow to open.

Decision, on the owner's plan of 2026-11-20 (#799): **the sentence ids stay exactly as they are; only the rendering moves.** The server emits the book's text ready to show, with each sentence wrapped and tagged with the id it already has, and the reader shows that. No alignment map is invalidated and no saved place, bookmark or checkpoint is migrated, because nothing they name changes.

## The prepared text

- **Sanitised HTML in parts of about 120 KB.** The server sanitises the book's markup once, when it prepares the text, instead of the browser sanitising every section as it is shown. A part is small enough to fetch and show at once and large enough that a chapter is a few requests.
- **A manifest with character counts.** It lists the parts in order with the characters each holds, so a position in the whole book (a percentage, the page in view on the position bar, the part that holds a sentence) is a lookup and needs no pass over the book.
- **Pictures under versioned addresses.** A picture's address changes when the book's file does, so the browser may keep it for good.
- **A disk cache.** The prepared text of an EPUB is made once and kept on the server's disk, keyed by the file it was made from.

The sentences are the ones `extractBook` returns. The prepared text is a second rendering of the same cut, and step 2 of the plan is done when, for every EPUB in the library, each tagged sentence equals the stored sentence text.

## Why: what opening the reader costs today

Measured on 2026-11-20 with `scripts/measure-reader-open.mjs` on a copy of production (build `2026-11-20T03:31:30.436Z`, `scripts/reader-open-copy.sh`), three books of the owner's library, median of five runs. Times count from opening Read on a loaded app. Cold is a browser that has never opened the app; warm is the same browser after a reload, with the scripts in its cache and the EPUB on the device. The desktop profile is 1280 by 800 and unthrottled; the phone profile is a Pixel 7 screen with the processor four times slower and a 10 Mbit/s connection. Bytes are what crossed the wire, compressed as the production site compresses, without audio.

| Book | Text | EPUB file | Profile | State | First text | Place shown | Following | Bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short | 5,771 sentences, 475,000 characters | 571 KB | desktop | cold | 2,433 ms | 2,433 ms | 2,665 ms | 1,508 KB |
| | | | desktop | warm | 561 ms | 561 ms | 1,024 ms | 348 KB |
| | | | phone | cold | 3,953 ms | 3,953 ms | 4,660 ms | 1,534 KB |
| | | | phone | warm | 979 ms | 979 ms | 1,594 ms | 348 KB |
| average | 12,410 sentences, 947,000 characters | 551 KB | desktop | cold | 2,458 ms | 2,458 ms | 2,818 ms | 2,181 KB |
| | | | desktop | warm | 477 ms | 477 ms | 753 ms | 694 KB |
| | | | phone | cold | 4,981 ms | 4,981 ms | 5,359 ms | 2,181 KB |
| | | | phone | warm | 1,341 ms | 1,341 ms | 2,046 ms | 694 KB |
| long | 29,230 sentences, 1,764,000 characters | 5,434 KB | desktop | cold | 3,212 ms | 3,212 ms | – | 8,583 KB |
| | | | desktop | warm | 796 ms | 796 ms | – | 1,454 KB |
| | | | phone | cold | 14,023 ms | 14,023 ms | – | 8,583 KB |
| | | | phone | warm | 3,087 ms | 3,087 ms | – | 1,458 KB |

| Book | Jump to another narrated place, desktop | phone |
| --- | --- | --- |
| short | 242 ms | 574 ms |
| average | 195 ms | 824 ms |
| long | 255 ms | 701 ms |

**First text** is the first frame with readable text in the text band. **Place shown** is the reader at its saved place with the loading line gone; with epub.js the two are the same moment, because no text shows before the whole book is open. **Following** is the narrated sentence highlighted at the saved listening place; the long book has no saved place, so it opens at its start, which the map does not cover. **Jump** is a seek of the paused narration to the middle of the loaded file's map, timed until that sentence is highlighted on the page.

On a cold open the reader loads two scripts it did not have: the chunk with epub.js (378 KB unpacked, 124 KB over the wire) and DOMPurify (30 KB unpacked, 13 KB over the wire). The app's first visit, before any book is opened, transfers about 10 MB on the desktop profile, 8 MB of it covers; that is outside this plan.

What the numbers show:

- **The whole book crosses the wire before the first word shows.** A cold open transfers the EPUB file, the server's sentences for the whole book (`GET /api/reader/:id`: 274 KB, 538 KB and 1,105 KB compressed for the three books) and the whole alignment map. The long book costs 8.6 MB and 14 seconds on the phone profile.
- **The cost grows with the book, not with the page.** One page of text is a few kilobytes; the bytes of an open are 1.5 MB, 2.2 MB and 8.6 MB.
- **A warm open still transfers the book's text.** The sentences are sent `no-store`, so every open fetches them again: 348 KB to 1,458 KB with everything else already on the device.
- **A cold open asks for the sentences and the map twice.** Both requests appear two times in every cold run (the bytes above count both); a warm open asks once.
- **The first text waits for everything.** Nothing is readable until epub.js has opened the whole file and laid out the section, so first text and place shown are one number.

## Decisions

Made by ray for the owner on 2026-11-20, after the owner handed over the deciding.

1. **Styling.** Prepared text keeps structure (headings, emphasis, centred lines, quotes, pictures) and drops the publisher's own fonts and layout.
2. **PDF and reading sync.** A PDF that passes the quality gate of step 8 may be the edition for reading sync.
3. **The position bar's saving behaviour.** A drag on the bar saves the reading place the same way a hand page turn saves it today.

## What is given up

The publisher's own fonts and layout. A book is set in the reader's typeface and the user's Appearance, and a publisher's stylesheet (its faces, sizes, margins, drop capitals, colours, page breaks) is not applied. Structure survives: headings, emphasis, centred lines, quotes and pictures.

## What step 7 must beat

Step 7 makes the new view the default and removes epub.js, DOMPurify and the frame code. Before it is done, the same command is run again, unchanged, on the same three books:

```bash
scripts/reader-open-copy.sh start
set -a; . <(grep '^APP_PASSWORD=' /home/jahn/audiobook_streamer/.env); set +a
SONDER_VERIFY_URL=http://127.0.0.1:3106 node scripts/measure-reader-open.mjs --runs 5 \
  --books short=libgen-08311e7f4b32b87f5cdda012fcc6d152,average=libgen-62ec0c927a28fea0af5f25b17252604d,long=libgen-91ea7453b23bbd6e88c50a66ee090803
scripts/reader-open-copy.sh stop
```

On every row of the tables above, the new view must be lower than the baseline for first text and for bytes, cold and warm, and no slower for place shown, following and the jump. Two results are named outright:

- **The scripts.** A cold open loads neither the 378 KB chunk with epub.js nor DOMPurify; both are gone from the build.
- **The long book.** Its cold open no longer transfers the whole book: the bytes of an open follow the part being read, not the book's length, so the long book's bytes come close to the short book's.

The times were taken on the production machine while other work ran on it; single runs of one row differ by up to a factor of two on the desktop profile (cold first text of the short book: 1,921 to 3,874 ms). Compare medians of five, and take a difference under a quarter as no difference.

## Considered options

- **Keep epub.js and make it faster** (cache the book's text on the device, load its script earlier). Refused: the whole EPUB is still downloaded and laid out in a frame, and the reader still has to find the server's sentences again in a layout it does not control. That search is where the reader's code and its hardest defects are.
- **Cut the sentences anew while preparing the text.** Refused: every alignment map, place and bookmark names a sentence of today's cut. A new cut would invalidate the maps (hours of alignment for each book) and need a migration of every saved place.
- **Prepare the text in the browser from the EPUB file.** Refused: the whole file is still transferred, and the sanitising and the cut would exist twice, on the server for alignment and on the device for reading, with nothing keeping the two equal.

## Consequences

- The reader's two modes (ADR 0017) and its one following module (ADR 0014) stay as decided; the new view is built against them, behind a hidden switch until step 7.
- ADR 0019 (nothing over the book's text) is amended in step 5, when the position bar's rail joins the text band's margin and its test includes the rail. It is not amended by this record.
- Keep on this device (ADR 0018, ADR 0021) stores the prepared parts instead of the EPUB file from step 6, and replaces EPUBs kept before.
- A text PDF becomes a second input that produces the same prepared text and the same kind of sentence ids (step 8); a PDF that fails the quality gate keeps today's behaviour.
- The measurement reads the page only through the room, the text band, the loading line, `data-current-passage` and the follow highlight, and counts text in the band itself or in a frame inside it. The new view keeps those names so the before and after are measured by the same script.
