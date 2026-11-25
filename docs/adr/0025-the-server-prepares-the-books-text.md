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

## Pages mode in the new view (step 4, #803)

Built behind the same hidden switch. A page is a CSS column (two side by side on a desktop with room for them). Nothing of the whole book is laid out.

**The rule (ray, 2026-11-21): every part begins on a new page, always, reading forwards and backwards; with two pages side by side, on a left page.** A part's pages depend on that part, the band and the style alone. Whatever parts are in the page around it, its text stands on the same pages, line for line. Nothing is measured or made up for when a part comes or goes.

- **How it holds: each loaded part is a run of columns of its own**, in a box exactly as wide as the whole pages its text fills, and the parts stand side by side. No part's text is in another part's columns, so no part can move a line of another; a part can only move the others by its whole pages. A forced column break in one run of columns for all parts would say the same in Chromium, but Firefox (157) has no forced column break: the first build of the rule passed every walk in Chromium and failed every one in Firefox.

- **A part before the pages shown** (put in as the reader nears the run's first page, taken out when it is far behind) moves them by the whole pages it fills, an even number with two pages side by side, and the band is put that many pages further. A part after them changes nothing before it. At most five parts are in the page, reading on or back.
- **Two pages side by side:** a part that fills an odd number of pages ends with an empty right page, so that the next part begins on a left page and which page is left and which right never depends on the parts loaded. The pages are counted, not measured: laid out one page wide, a part's columns run on beyond its box by a whole number of pages.
- **A part is whole in the page before any of its pages is shown.** A turn towards a part that is not there yet waits for it; no page is seen half empty and then filled.
- **Its price: a short page where a part ends inside a chapter, reading forwards too.** A part is cut by size (about 120 KB), between two paragraphs, so a chapter longer than a part is cut inside. The page before the cut ends early, as before a chapter's heading, and with two pages the right page may be empty. This is not rare in this library: in Snow Crash 9 of 13 joints between parts are inside a chapter, in one edition of The Picture of Dorian Gray 31 of 64, in Look to Windward 8 of 10; in such books about once every 60 to 100 pages of a phone. Where a part ends with its chapter the page would end there anyway.
- **What was tried first and given up (2026-11-21):** parts that run on in the column the part before ended in, so that no page is short. Then every part's place depends on the parts before it, and each part that came or went before the reader had to be made up for by a measured space (above the run, and between two parts for a reader who came backwards). Three reviews each found a path on which that did not hold (sentences shown again or hidden, a page with no text), and on real books a turn forward again was not always the page that was left. The rule above replaces the measuring by a property that holds by construction.
- **Not built, for a follow-up:** the server could prefer a chapter's end as the place to cut a part when one lies near the size limit, which would put most short pages where a new page is natural. Sentence ids would not change.
- **The page is held by a place in its text**, never by a column's number. The place is where the reader last moved to: the top of a page turned to, a sentence jumped to, the page the narration turned to. It stays that until the reader moves again. A layout made anew (a band resized, Appearance opened, another size of text, a picture that arrived) shows the page that holds the place and never takes the place anew: taken anew, each resize and back moved the reader a page (found in review, 2026-11-21).
- **Every length of a page is a whole number of px.** A browser stretches columns to fill their box, so in a band of an odd width (two pages) or a fractional one the columns were a fraction wider than reckoned and the pages drifted, a px or more every few turns. The text's box is given the width of exactly one page or two, at most a px per page narrower than the band.
- **The band reaches as far as the page shown.** A scrolled box goes no further than its content, and the last column's margin is not content: an empty box placed beyond the page shown keeps the last page of the run, and a single column on the left of two pages, at the margin.
- **A tap for a page whose part is still on its way** turns the page when the part is there; the tap is not lost (the fault of #445, not repeated here).
- **The browser's own scroll** (a link focused with the keyboard, a word found in the page) is answered by showing the whole page that holds what it showed.
- **A page's saved place is the first sentence that starts on it**, so opening the place shows a page that holds it.

**A place opened again shows exactly the page that was left**, at the same width and style: the saved place is the first sentence that starts on the page, and a part's pages are the same however the reader came to them. (Before the rule above, a part read into ran on in the column of the part before, and a place opened again showed the saved sentence on a page that could begin a few lines earlier or later.)

**Measured** on a copy of production, the new view, median of 3, pages mode against scroll mode on the same image and night (`--mode pages` and `--mode scroll`), the books of the baseline above:

| Book | Profile | State | First text pages / scroll | Place shown pages / scroll | Following pages / scroll | Bytes pages / scroll |
| --- | --- | --- | --- | --- | --- | --- |
| short | desktop | cold | 245 / 428 ms | 391 / 607 ms | 1,202 / 1,391 ms | 180 / 180 KB |
| short | desktop | warm | 137 / 145 ms | 237 / 287 ms | 387 / 407 ms | 144 / 144 KB |
| short | phone | cold | 1,022 / 953 ms | 1,086 / 1,085 ms | 1,921 / 1,888 ms | 206 / 206 KB |
| short | phone | warm | 472 / 370 ms | 717 / 479 ms | 894 / 553 ms | 144 / 144 KB |
| average | desktop | cold | 224 / 1,185 ms | 360 / 1,185 ms | 1,231 / 1,295 ms | 409 / 409 KB |
| average | desktop | warm | 101 / 113 ms | 186 / 191 ms | 310 / 319 ms | 170 / 170 KB |
| average | phone | cold | 898 / 858 ms | 1,010 / 974 ms | 2,056 / 2,067 ms | 409 / 409 KB |
| average | phone | warm | 378 / 344 ms | 586 / 496 ms | 756 / 610 ms | 170 / 170 KB |
| long | desktop | cold | 209 / 1,737 ms | 322 / 1,737 ms | – / – ms | 1,662 / 1,662 KB |
| long | desktop | warm | 119 / 111 ms | 246 / 248 ms | – / – ms | 1,123 / 1,123 KB |
| long | phone | cold | 852 / 2,751 ms | 967 / 2,751 ms | – / – ms | 1,709 / 1,662 KB |
| long | phone | warm | 407 / 387 ms | 915 / 860 ms | – / – ms | 375 / 1,123 KB |

Bytes and requests are the same in both modes. Pages mode is no slower to open cold. Warm on the phone profile (the processor slowed four times) it shows its place 60 to 340 ms later than scroll mode: a whole part is laid out in columns before the page is shown. The long book's cold figures favour pages mode because in scroll mode its first screen waits for the cover picture.

**Real books in pages mode** (Chromium with a Pixel 7 profile and Firefox, 2026-11-21): The Picture of Dorian Gray Parts Edition, The State of the Art, the "bionic reading" edition, a book of 52 large pictures, a book with 132 pictures and a three-column table, a book with a 239-row table, 60 to 120 pages each, the last three also as two pages on a desktop: never an empty page, no line cut by a page's edge, no picture or table over an edge, at most five parts in the page, back and forward again the same pages line for line. On a book with a reading sync map, 120 narrated sentences on: the part being narrated was on the page shown every time, also inside each sentence that breaks over two pages. Not checked: a table wider than three columns (the library has none; a table is held to the page's width by the stylesheet, untested on a real wide one) and a real Android phone or emulator (the emulator's host was unreachable).

Not explained: The State of the Art once did not open within 90 seconds on its first preparing in the copy and opened in 7 seconds the next time; and the long book's warm phone median in pages mode (375 KB) lacks the bytes of the reading sync map that every other warm row of that book carries (1,123 KB).

