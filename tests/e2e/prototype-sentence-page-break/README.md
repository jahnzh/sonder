# PROTOTYPE: where a sentence breaks across two pages

Throwaway code for [jahnzh/sonder#457](https://github.com/jahnzh/sonder/issues/457). It is on a branch that is never merged. Nothing here is production code or part of the test suite.

## Question

Can the reader find, from what epub.js has rendered, the first word of the narrated sentence that lies on the next page, reliably enough to turn the page at that word's estimated time? Or should it use the agreed fallback and turn at the sentence's midpoint?

## Answer

**The exact break.** It can be read from the page, in Chromium and in Firefox, and it costs about 1 to 2 ms per sentence that crosses a page.

- Over 3,600 crossing sentences were compared (a fixture and all of one real book, several sizes and windows). A binary search over the word boxes gave the same break as checking every word, every time.
- The midpoint would be a poor stand-in: in the real book the exact break lies a median 1.3 to 1.7 s from the sentence's midpoint, and more than 4.3 to 4.7 s for one crossing sentence in ten.
- One condition: the reader's present lookup from a sentence offset to a place in the page (`rangeAt` in `src/components/Reader.tsx`) is too slow for this and needs the faster form shown here.

WebKit was not measured: it cannot start on the server this ran on (missing system libraries).

## How to run

```bash
npm run build
npx playwright test -c tests/e2e/prototype-sentence-page-break/playwright.config.ts

# with one real book and its sentence times ({ "<paragraphId>": { "start": s, "end": s } })
PROTOTYPE_EPUB=/path/book.epub PROTOTYPE_MAP=/path/intervals.json \
  npx playwright test -c tests/e2e/prototype-sentence-page-break/playwright.config.ts
```

It starts the app's own browser test server on port 4391 (`PLAYWRIGHT_PORT` changes it), opens the real reader at 390 by 844 and writes numbers and screenshots to `artifacts/prototype-page-break/`. A full run takes about 8 minutes per browser, nearly all of it in the slow reference method.

## What it does

`measure.ts` is bundled and loaded into the app's page. It takes the reader's epub.js rendition out of React, shows each section, and for every sentence of the reader's manifest works out the page on which each word starts. A page is `Math.floor(x / layout.delta)` of a word's first box, in the coordinates of the section's frame. With two pages side by side, `delta` spans both, so a "page" is what one turn moves.

| Method | How | Role |
| --- | --- | --- |
| linear | One `Range` per word with the reader's own `rangeAt`, every word in order | The reference |
| binary | The same boxes, the first word after the page found by binary search | Shows the search is sound |
| fast | Binary search, with a lookup that walks the block once and searches the offset | What a build would use |
| caret | Hit-test (`caretPositionFromPoint`) on the sentence's first box on the next page | An independent second opinion |

The break is the first word that **starts** on the next page.

## Results

Fixture: 171 generated sentences in two chapters, with headings, emphasis, soft hyphens in long words, `<br/>` lines and one sentence of 480 words. Real book: The Left Hand of Darkness, 5,771 sentences, with the sentence times of its reading sync map. "Size" is the reader's setting; the text is 1 px larger at this width.

### Agreement

| Run | Crossing sentences | Over three pages or more | Break inside a word | linear ≠ fast | linear ≠ caret |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium, fixture, sizes 14, 19, 24, 30 | 25, 48, 79, 117 | 1, 1, 1, 4 | 7, 15, 22, 35 | 0 | 0 |
| Chromium, fixture, resized to 430 by 932 | 33 | 1 | 7 | 0 | 0 |
| Chromium, fixture, landscape 932 by 430 | 128 | 12 | 40 | 0 | 0 |
| Chromium, fixture, desktop 1440 by 900 (two pages side by side) | 19 | 0 | 4 | 0 | 0 |
| Chromium, real book, sizes 19, 24 | 478, 852 | 0, 1 | 11, 10 | 0 | 0 |
| Firefox, fixture, sizes 14, 19, 24, 30 | 27, 48, 80, 120 | 1, 1, 1, 7 | 10, 15, 24, 40 | 0 | 0 |
| Firefox, fixture, resized, landscape, desktop | 38, 133, 23 | 1, 17, 0 | 10, 42, 7 | 0 | 0 |
| Firefox, real book, sizes 19, 24 | 532, 905 | 0, 1 | 11, 13 | 0 | 0 |
| Both, a picture in the middle of a sentence, four sizes | 5 and 6 | 0 | 0 | 0 | 2 and 2 |

- The resize was made while the reader was open; the measurement after it agrees as before.
- **The picture is the one place the hit-test fails.** The line that holds the picture is as tall as the picture, the words before it sit at its bottom, and the hit-test lands on the picture's box. The word boxes are right; see `shots/picture-page1.png` and `shots/picture-page2.png`. A build should use the word boxes and not hit-testing.
- An inline `<svg>` never reaches the page (the reader's sanitiser removes it), so the picture case uses an image file of the book.
- A heading at the top of the next page causes nothing: a sentence does not reach across blocks.

### Cost

Per sentence, in milliseconds.

| Run | Does it cross? (every narrated sentence) | Find the break, fast (mean, worst) | Find the break, today's `rangeAt` (mean, worst) |
| --- | ---: | ---: | ---: |
| Chromium, fixture | 0.18 to 0.24 | 0.8 to 1.0, 23 | 19 to 31, 1,245 |
| Chromium, real book | 0.18 to 0.24 | 0.8 to 1.1, 10.5 | 24 to 29, 773 |
| Chromium, fixture, processor slowed 6 times | 1.3 | 5.9, 59 | 142, 2,863 |
| Firefox, fixture | 0.30 to 0.41 | 1.3 to 1.8, 39 | 24 to 47, 1,769 |
| Firefox, real book | 0.23 to 0.24 | 0.9 to 1.0, 8 | 25 to 27, 615 |

The worst cases are the 480-word sentence. `rangeAt` tries every character of a text node and normalises the whole prefix each time, so its cost grows with the square of the paragraph's length.

### How far the midpoint is from the exact break

Real book, crossing sentences that have times (median length 8.1 s, one in ten over 15.9 s).

| Run | Sentences | Median | 90th percentile | Largest |
| --- | ---: | ---: | ---: | ---: |
| Chromium, size 19 | 474 | 1.72 s | 4.57 s | 8.85 s |
| Chromium, size 24 | 844 | 1.42 s | 4.55 s | 17.88 s |
| Firefox, size 19 | 526 | 1.32 s | 4.26 s | 10.65 s |
| Firefox, size 24 | 895 | 1.41 s | 4.74 s | 17.88 s |

About one sentence in twelve crosses a page at the default size (478 of 5,771), one in seven at size 24.

## What a build needs

1. **A faster lookup.** `fastFind` in `measure.ts`: walk the block's text nodes once, then binary-search the raw prefix length whose normalised length reaches the target. It gave the same ranges as `rangeAt` in every comparison above. It can replace the inside of `rangeAt`.
2. **When to measure.** After the section's fonts have loaded and the layout has settled, when a narrated sentence begins, and again after a change of font, size or window. It is cheap enough to do every time and need not be cached.
3. **The page of a word** is `Math.floor(left / rendition.manager.layout.delta)` of its first box. That also covers two pages side by side.
4. **A break inside a word.** Between 1 and 2% of the real book's crossing sentences break inside a word, at a hyphen ("place-event-" / "phenomenon-behavior"). The first word that starts on the next page is then up to a second late. Better: find the first character on the next page with the same search inside that one word, and take that share of the word's time.
5. **More than one break.** A sentence over three pages has a break per page. After a turn, the next break is the first word after the page now shown.

## Not covered

- WebKit, and so iPhone. The build's check on a real phone has to cover it.
- A real phone's speed. The 6 times slowed processor is a stand-in.
- Pictures that load late and move the page breaks. Measuring when each sentence begins limits a stale break to one sentence.
- One or two sentences of the real book per run failed the prototype's own sanity check on the first word's text; their breaks agreed all the same. Not looked into.
- Right-to-left and vertical text.

## Files

- `measure.ts`: the measurement, loaded into the page.
- `page-break.prototype.ts`: the fixture, the runs and the screenshots.
- `playwright.config.ts`: its own config, so the suite never runs it.
- `results/`: the numbers of the runs above. The real book's text is left out.
- `shots/`: page pairs from the fixture with the sentence shaded and the break word outlined.
