# A book whose paragraphs are not paragraph elements is cut by another rule

The extractor (`extractBook`, `server/reader.ts`) cuts a chapter into sentences block by block, and a block is one of `p, h1 to h6, li, blockquote, pre, figcaption` that holds no other such element (`countedBlocks`, `src/reading-types.ts`). Only a chapter with none of them is read as one block. Some conversions keep their prose elsewhere: every paragraph a `<div>` with a `<span>` in it, or loose text in `<body>` between `<p>` elements that hold only a space. Such a chapter has a few standard blocks (its headings and quotations), so those are all that is cut, and the rest of the book can be shown but not followed, highlighted, bookmarked, searched or aligned. In the library of 2026-11-20 that was one work in five editions: 85 or 16 sentences holding 1.5 % or 0.1 % of the text, and a reading sync job that ended with coverage 0 (#815).

A sentence id is its chapter file and its count in that file. Every alignment map, reading place and bookmark names a sentence by it, so the cut of a book that is cut well must not move.

Decision, made by ray for the owner on 2026-11-20: such a book gets a real cut, and no other book changes.

- **Judged per book.** A book whose standard blocks hold less than half of its text (`LOW_SHARE_BOOK`) is cut by the rule below. Every other book keeps the standard rule in every chapter, an odd chapter included.
- **Applied per chapter.** In such a book each chapter uses the first of three rules whose blocks hold at least nine tenths of the chapter's text (`CHAPTER_SHARE`): the standard rule; the standard rule with `<div>` as a block too (`div`); the whole chapter as one block (`body`), which is what a chapter without any block has always been.
- **The section says which.** `ReaderSection.blocks` carries `div` or `body`; without it the rule is the standard one. The reader counts a chapter's blocks with the same function and the section's rule, so the server decides once and nothing is judged twice.
- **Saved places are carried over.** The first time such a book is cut after this change, its reading places and bookmarks are moved from the standard cut to the sentence that now holds the start of the old one, and the edition is marked (`settings`, key `reader-recut:<edition>`) in the same transaction. A moved reading place gets the next revision.

## Why per book, and why these lines

The library on the day of the decision, 80 EPUBs: the five editions of the one work are at 0.1 % and 1.5 %; the next lowest book is at 94.7 %, and the median is 98.6 %. Half is far from both.

Judging each chapter alone would have changed other books. Seven chapters of seven other editions are under half in standard blocks, among them a 21,000-character appendix that is loose text in three editions of one novel, and a contents page. Their books are cut well, their ids are in use, and the text outside their blocks was never a sentence. A rule per chapter would have added sentences to them. A normal book with one odd chapter therefore keeps that chapter as it is: its loose text is shown and is not a sentence. That is today's behaviour for every such book, and changing it is another decision.

A book that arrives later has no ids yet, and the rule depends only on its file, so it gets the same cut every time it is read.

## What is given up

- **Sentence quality in a `body` chapter.** Its blocks have no boundaries, so a heading runs into the sentence after it, and a file that leaves no space after a full stop gets long sentences. It is still the book's text, in order.
- **A build of the app from before this change** does not know the section's rule and looks for these books' sentences in the standard blocks. It shows the text and misplaces the highlight until it updates.
- **A map made on the standard cut of such a book is not found stale by itself**, because the file's fingerprint does not change. On the day of the change the five editions had one job between them, with no map. A book of this kind that arrives later is cut by its rule from the start.

## Considered options

- **Count `<div>` as a block everywhere.** Refused: it renumbers the sentences of every book that has text in a `<div>` beside its paragraphs.
- **Judge each chapter alone.** Refused for the books that exist, as above.
- **Give such a book another fingerprint**, so that maps and device copies notice the change by themselves. Refused: a device fingerprints the EPUB it keeps with SHA-256 and compares it with the server's (ADR 0018), so those books could no longer be kept.
- **Loose text as blocks of their own.** A block has to be an element, for the reader that finds a block in the page and for the prepared text (ADR 0025). The whole chapter as one block needs nothing new.
