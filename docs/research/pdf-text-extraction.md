# Can text PDFs feed the reader's sentence pipeline?

The reader plan (map #799) makes text PDFs a second input to the pipeline that cuts EPUBs into numbered sentences (step 8, #807), behind a quality gate, and shows the rest as page images (step 9, #808). Extraction quality was the untested risk. This spike ran poppler's `pdftotext` and a throwaway pipeline over 22 PDFs, the owner's and public ones, and read the result against the pages.

**Short answer.** It works for one kind of PDF and not for the others. A PDF that was typeset or converted from text, in one column, of running prose, extracts to sentences that match the book: the owner's 996-page novel gives 99.2 % of its sentences letter for letter as the EPUB of the same book has them, all in order. Everything else in the sample fails: technical books (code, tables, lists), documents in columns, anything with footnotes, and every scan with an OCR text layer, including the owner's one (95 % of sentences right, the rest broken or scrambled). Four of the 22 pass the gate proposed in §4, two of the owner's three. **Recommendation: build step 8 with the changes named in §5, for that one kind only, and give it low priority:** the owner's library holds two PDFs among 89 ebooks, both of books that also have an EPUB, so today step 8 makes no book readable that is not readable already. Sentence ids are stable if a PDF's sections are its pages (§5.2).

Sources are pinned. poppler `22.12.0-2+deb12u3` (Debian bookworm, what `node:24-bookworm-slim` installs) and `25.03.0` (Debian trixie) for the comparison. Node 24 for `Intl.Segmenter`. Sonder references are repo paths at `9643581`. The spike's scripts are in [`pdf-text-extraction/`](pdf-text-extraction/) (§7); they are not application code.

---

## 1. What was run

- **The sample (22 PDFs).** The library's storage was read only: `ebook_editions` has 87 EPUBs and 2 PDFs. Both PDFs belong to works that also have an EPUB, which gives ground truth. A third PDF of the owner's lies beside an audiobook download (sample chapters; not an ebook edition). That is fewer than five text PDFs, so 19 public PDFs were added: public domain, US government works, or openly licensed books. They are named in §2; the owner's are named by kind and size only.
- **poppler in a container.** `sudo` needs a password on this machine, so `poppler-utils` ran in throwaway containers (`node:24-bookworm-slim` plus the package; `debian:trixie-slim` plus the package), with `--network none` and the PDFs mounted read only. Nothing was installed on the host and nothing in production was touched.
- **`pdftotext`, four modes**, each as its own process: `-bbox-layout` (words with boxes, grouped into lines, blocks and flows in poppler's reading order), `-layout`, plain, and `-raw` (the order of the page's content stream, no layout analysis). `pdftohtml -xml` gave the outline (bookmarks).
- **The throwaway pipeline** (`pipeline.mjs`, about 430 lines): headers, footers and page numbers; drop caps; footnotes held back until the paragraph ends; paragraphs from line geometry; hyphens at line ends; then `normalizeReaderText` and `Intl.Segmenter("en", { granularity: "sentence" })` exactly as `extractBook` uses them (`server/reader.ts:146-158`), with ids `<section>:<n>`.
- **Three reading orders** were built for every book: poppler's layout order, the `-raw` order (each raw word given its box from the layout output), and a purely geometric one (lines by height on the page).
- **Judging.** Six books have ground truth: the two library PDFs against their EPUBs, and four public ones against Project Gutenberg's text of the same work (a different edition, so that figure is a lower bound). For every book the first 200 sentences were read, and pages were rendered where the text looked wrong.

## 2. Results per PDF

Columns: **text pages** have 50 letters or more. **Order** is the share of pages where the layout order and the raw order disagree (§4, signal 2). **Broken** is the share of prose paragraphs (eight words or more) that start with a lower-case letter, **open** the share that do not end a sentence. **Time** is `pdftotext -bbox-layout` for the whole book, then the pipeline (parse and one build); `pdftotext` peaked at 11–22 MB for every book.

| # | Kind (size) | Pages | Text pages | Order | Broken | Open | Time, s | Gate |
|---|---|---|---|---|---|---|---|---|
| o1 | **Owner's.** Scan with an OCR text layer, essay (3.8 MB) | 86 | 85 | 0 % | 13.4 % | 25.1 % | 0.2 + 1.0 | fails |
| o2 | **Owner's.** Converted from an EPUB by calibre, novel (65.9 MB) | 996 | 907 | 0 % | 0.1 % | 3.0 % | 2.1 + 5.8 | **passes** |
| o3 | **Owner's**, not a library edition. Plain text PDF, sample chapters of a novel (0.1 MB) | 41 | 41 | 0 % | 0.5 % | 2.7 % | 0.1 + 1.1 | **passes** |
| p01 | Typeset novel, *Pride and Prejudice* (Planet eBook) | 479 | 477 | 0.4 % | 2.3 % | 8.3 % | 1.1 + 2.4 | **passes** |
| p02 | Typeset novel, *Moby-Dick* (Planet eBook) | 861 | 860 | 1.2 % | 3.8 % | 7.8 % | 1.7 + 4.1 | **passes** |
| p03 | Court opinion with footnotes (US Supreme Court, 22-451) | 114 | 114 | 0 % | 20.6 % | 34.4 % | 0.2 + 0.8 | fails |
| p04 | Three columns and tables (IRS Publication 17) | 142 | 142 | 43.7 % | 20.4 % | 42.8 % | 1.5 + 3.2 | fails |
| p05 | Technical report (NIST SP 800-63-3) | 76 | 76 | 15.5 % | 1.5 % | 25.2 % | 0.2 + 0.6 | fails |
| p06 | Technical book with code, LaTeX (*Think Python* 2e) | 244 | 236 | 0 % | 19.3 % | 37.4 % | 1.0 + 2.1 | fails |
| p07 | Technical book with code (*Eloquent JavaScript*) | 463 | 461 | 3.5 % | 15.3 % | 29.4 % | 0.9 + 2.5 | fails |
| p08 | Technical book with code (*Pro Git*) | 501 | 498 | 1.4 % | 6.9 % | 44.3 % | 1.2 + 4.3 | fails |
| p09 | Technical book, footnotes and code (*SICP*, unofficial Texinfo edition) | 883 | 879 | 1.9 % | 21.7 % | 61.6 % | 1.8 + 6.8 | fails |
| p10 | Two-column paper with figures (arXiv 1512.03385) | 12 | 12 | 91.7 % | 27.6 % | 47.2 % | 0.1 + 1.0 | fails |
| p11 | Two-column report (CDC MMWR 72(1)) | 8 | 8 | 75 % | 39.9 % | 85.5 % | 0.1 + 0.9 | fails |
| p12 | Report with tables and side boxes (GAO-23-106203) | 286 | 284 | 0.4 % | 17.3 % | 40.9 % | 0.7 + 1.8 | fails |
| p13 | Two-column fact sheet (USGS FS 2011-3008) | 2 | 2 | 100 % | 63.6 % | 84.1 % | 0.0 + 0.2 | fails |
| p14 | Scan without a text layer, poems (Google scan, Internet Archive) | 180 | 1 | – | – | – | 0.1 + 0.1 | fails |
| p15 | Scan with OCR, novel of 1861 (Internet Archive `greatexpectation01dick`) | 356 | 346 | 5.5 % | 37.5 % | 48.1 % | 0.6 + 2.7 | fails |
| p16 | Scan with OCR, science of 1900 (Internet Archive `originofspecie00darw`) | 572 | 555 | 1.8 % | 32.0 % | 37.5 % | 14.6 + 5.4 | fails |
| p17 | Scan with OCR and footnotes, 1890 (Internet Archive `principlesofpsyc02jame`) | 712 | 700 | 4.6 % | 53.7 % | 62.7 % | 2.5 + 6.8 | fails |
| p18 | Scan without a text layer (Google scan, Internet Archive) | 718 | 1 | – | – | – | 0.8 + 0.2 | fails |
| p19 | Scan with OCR, two-column magazine of 1897 (Internet Archive `theDial-18970516`) | 24 | 24 | 37.5 % | 46.8 % | 60.9 % | 0.8 + 0.9 | fails |

The same books as a reader sees them:

| # | Reading order | Headers and footers | Hyphens at line ends (joined / kept) | The first 200 sentences against the page |
|---|---|---|---|---|
| o1 | In order; inside some lines the OCR layer's words come out reordered or missing | Four page numbers removed; nothing leaked | 116 / 25. Against the EPUB: 7 joined wrongly, 5 left split | Contents page scrambled with its page numbers, then fluent. 88 % of them equal the EPUB's; whole book 94.7 % |
| o2 | In order, every matched sentence (100 %) | The PDF has none; nothing removed | 8 / 61. Against the EPUB: 2 joined wrongly, none left split | Title pages and credits, then fluent. 93 % equal the EPUB's; whole book 99.2 %. One chapter opening lost its first five words (§3.1) |
| o3 | In order | None present | none | Fluent. Front-matter lines stay separate (unjustified text) |
| p01 | In order (99.9 %) | 956 footer lines removed, none leaked. They sit at 85 % of the page height | 1836 / 45. Against Gutenberg: 3 joined wrongly, 29 left split | Fluent from the first page, but each chapter's first word is split at its drop cap ("I t"). 82 % equal Gutenberg's edition; the rest read right and differ by edition |
| p02 | In order (100 %) | 1720 removed, none leaked | 2721 / 265. Against Gutenberg: 10 joined wrongly, 129 left split | Etymology and extracts (verse) come out line by line, then fluent. Whole book 94.8 % |
| p03 | Body in order; footnotes follow their paragraph | **Not removed:** the running head sits at 16 % of the page height, outside the zone, and leaks 56 times | 888 / 26 | Running heads between sentences; citations cut at every "U. S." (the splitter, not the PDF) |
| p04 | Columns mostly right; tables and worksheets in pieces | 422 removed | 3472 / 101 | Bulleted prose reads; tables do not |
| p05 | Prose in order | 217 removed, but a rotated margin note leaks on 75 pages, one word per line | 5 / 6 | Fluent prose with stray bullets and the margin note |
| p06 | In order | 439 removed | 272 / 19 | Preface and a list of names read; code is cut into fragments |
| p07 | In order | 480 removed | 379 / 26 | All 200 are the contents list with dot leaders |
| p08 | In order | 498 removed | 6 / 56 | Prose reads; lists of names and commands are fragments |
| p09 | In order | 925 removed | 2639 / 234 | Contents list. **Letters are missing** where the font has ligatures without a text mapping (§3.1) |
| p10 | **Wrong:** figure labels and the margin stamp land between sentences; the raw order is better | 12 removed | 152 / 12 | Abstract, then axis labels of a figure, then text |
| p11 | Order right, but the narrow columns stay one line per paragraph | 27 removed | 17 / 0 | Not sentences: lines |
| p12 | Prose in order; tables in pieces; side boxes inside the flow | 568 removed | 11 / 36 | Summary reads; the table that follows is fragments |
| p13 | As p11 | none | 38 / 3 | Lines, not sentences |
| p14, p18 | – | – | – | Only Google's notice page has text |
| p15 | **Wrong** in layout order (lines split and shuffled); readable in raw order, where still only 20 % of Gutenberg's sentences are found | 669 removed; OCR variants of the head leak | 605 / 142 | Layout: fragments. Raw: recognisable prose with OCR errors and missing lines |
| p16 | In order, footnotes inside the flow | 146 removed; about 300 garbled heads leak | 2892 / 200 | Readable with OCR errors; 30 % equal Gutenberg's |
| p17 | Words dropped from lines, stray quote marks as sentences | 1244 removed | 2992 / 517 | Not readable as sentences |
| p19 | Advertisement columns shuffled | 44 removed | 335 / 34 | Fragments |

Cost: `pdftotext` took at most 2.5 s for a book, except one 44 MB scan at 14.6 s, and never more than 22 MB. The `-bbox-layout` output of the 996-page novel is 33 MB. The spike's Node process peaked at 82–523 MB because it keeps every word of the book for three reading orders at once; a real implementation that works page by page needs a fraction of that.

Running the same poppler twice gave byte-identical output for all 22.

## 3. Failure kinds

### 3.1 Text that `pdftotext` cannot see or cannot order

- **Words in a font with no text mapping vanish silently.** In the owner's novel one chapter opens with five words in small capitals ("Of all the rooms in") drawn in a Type 3 font; `pdftotext` emits nothing for them, and `pdffonts` reports the font as having a Unicode map. In p09, ligatures are missing the same way: "This is" comes out as "is is". Nothing in the output marks the gap. Only a comparison with another edition finds it.
- **OCR text layers are fragmented by poppler's layout analysis.** OCR places words with wide gaps and wavering baselines. poppler takes the gaps for columns and splits one printed line into several flows. In p15 a single page yields one-word "blocks" in shuffled order. The `-raw` order repairs most of that for p15 (sentences found in Gutenberg's text: 31 % → 59 %) but not for the others, and a geometric rebuild of the lines did not help beyond that (o1: 94.7 % → 96.3 %; p16 no gain). The limit is the OCR itself.
- **Two columns with figures or tables.** Plain two-column prose keeps its order. Figure labels, table cells and margin stamps are placed between sentences (p10, p04, p12).
- **Rotated margin text** arrives as a column of single words (p05, 75 pages).
- **There is no structure in the output.** `-bbox-layout` gives boxes and text: no font, size, weight or italics, no headings, no pictures, no chapters. A line's height stands in for its font size. `pdftohtml -xml` (same package) gives fonts and the outline, but in content-stream order without layout analysis. Only 11 of the 22 PDFs have an outline, and one of the owner's three.

### 3.2 Headers, footers and page numbers

- **Position varies more than a fixed margin allows.** Footers at 85 % of the page height (p01, p02) and a running head at 16 % (p03) fall outside a 12 % or 15 % zone. p03's head was missed entirely.
- **A body line can look like a header.** The last word of a paragraph, carried to the top of a page, recurred on three pages of the owner's novel ("him.") and the first version of the rule deleted it. The rule now also requires that the line's height on the page mostly holds recurring text.
- **OCR variants defeat recurrence.** In p16 the same running head is read a dozen ways ("EISTOmCAL SKETCH"), so about 300 of them stay, some in the middle of a sentence that crosses the page.

### 3.3 Hyphens at line ends

The pipeline joins when the joined word occurs elsewhere in the book, keeps the hyphen when the compound occurs elsewhere, and otherwise guesses.

- **Left split:** "fashion-able", "trim-ming", "delight-ing" (p01). The guess "both halves are words, so it is a compound" was right 157 times and wrong 215 times over the six books with ground truth. Joining unless the compound is seen elsewhere is the better rule.
- **Wrongly joined:** "chimneypiece", "byblows", "zombiemaker": real compounds that occur once, at a line end. 2 in the owner's novel (of 69 line-end hyphens), 7 in his essay (of 141), 3 in p01 (of 1881).
- A PDF made by calibre has almost no line-end hyphens (69 in 996 pages); a typeset novel has four per page.

### 3.4 Paragraphs and sentences

- **Unjustified text.** Whether a short line ends a paragraph is decided by whether the next word would have fitted. That holds for justified prose and breaks in narrow columns (p11, p13) and unjustified front matter (o3).
- **Lists, code, tables, contents pages** become one "sentence" per line or cell. They are most of what fails in the technical books (p06–p09, p12); the prose between them reads well.
- **Footnotes.** Holding a footnote until its paragraph ends works when the note is smaller than the body and starts with a mark (p03). The same test also catches small print that is not a footnote (code, table text: 7488 lines in p04), and fails on scans, where line heights waver.
- **Drop caps** come out in two ways. As a line of their own they are easy to put back, and the spike does (p13, p17). As a separate word in the first line they leave "I t is a truth" at each of p01's 61 chapters; the spike does not repair that, and a real pipeline should join a tall first letter to the word after it.
- Not PDF failures: the splitter cuts after "Mr." and "U. S." for EPUBs as well.

## 4. The recommended quality gate

Measured on the built text, in this order; the first failure decides.

| # | Signal | Threshold | Passes alone (of 22) | Why |
|---|---|---|---|---|
| 1 | Share of pages with text (50 letters or more) | ≥ 80 % | 20 | The plan's starting point. Scans without a layer score under 1 %: Google's scans carry one text page, so "has any text" is the wrong test. 90 % would be too tight: the owner's novel has 91.1 % because of its pictures. |
| 2 | Pages where layout order and raw order disagree (fewer than 90 % of the page's once-only words in the same relative order) | ≤ 5 % of pages | 15 | The only check of reading order that needs no second edition. Catches columns with figures and fragmented OCR before anything is built. |
| 3 | Prose paragraphs that start with a lower-case letter | ≤ 6 % | 7 | A sentence cut in two. |
| 4 | Prose paragraphs that do not end with `.`, `!`, `?` or `…` (plus closing quotes) | ≤ 15 % | 6 | Lines, cells and fragments. The widest margin in the sample: passing books have 2.7–8.3 %, failing ones 25 % or more. |

- **All four together pass 4 of 22**: o2, o3, p01, p02. Of the owner's three, two; of the two in his library, one (the novel).
- **None that pass read badly.** Their flaws: one lost chapter opening in o2, front matter line by line, 1.5–4.3 % of line-end hyphens left split in the two typeset novels, and in p01 a split first word at each chapter's drop cap (§3.4).
- **Some that fail read acceptably in their prose**: the owner's essay (95 % of sentences right), and the technical books p05, p06 and p08 between their code and lists. The gate is deliberately for running prose; a looser gate would let a book through whose every twentieth sentence is broken.
- In this sample signal 2 rejects nothing that signals 3 and 4 do not also reject. It stays because it is the one signal that sees sentences that are fluent but in the wrong order.
- **Not needed:** a word list. The share of dictionary words was 91–99 % for every book, scans included; modern OCR writes real words in the wrong place. The image needs no dictionary package.
- The thresholds rest on 22 books of which four pass. They separate this sample with room to spare; they are not validated beyond it. Step 8 should record the four numbers for every PDF it judges, so the thresholds can be corrected from real use.

## 5. Recommendation for step 8

**Build with named changes, at low priority.** The approach works where it works: all four born-digital, single-column prose PDFs pass and read as the book does. It does not extend to the other kinds, and no tuning in this spike changed that. For the owner's library as it is, the gain is nil: both PDFs have an EPUB beside them, and the PDF that passes is itself a conversion of an EPUB. Step 8 earns its place when a book turns up that exists only as a text PDF. Deferring it until then costs nothing that this document does not preserve.

### 5.1 What `pdftotext` cannot do that the plan assumes

- **"Words with their positions" is not enough for "structure".** Decision 1 of the plan keeps headings, emphasis, centred lines, quotes and pictures. From `pdftotext` a PDF yields plain paragraphs. Headings can be guessed from line height, and nothing else survives. Step 8 should promise plain paragraphs.
- **Chapters.** Only the outline gives them, through `pdftohtml -xml`, and half the sample has none. Without an outline the Chapters page has nothing better than page numbers.
- **Reading order of OCR layers**, and **text in fonts without a mapping** (§3.1). The second cannot be detected.
- **Pictures** are not extracted. The owner's novel has 89 pages that are pictures or blank.

### 5.2 Named changes

1. **A PDF's sections are its pages:** ids `<page>:<n>`, with the outline's entries as contents entries that point at pages. See stability below.
2. **Gate on the built text** with the four signals of §4, not on the share of pages with text alone, and with 80 % for that share.
3. **Three poppler calls per book:** `pdftotext -bbox-layout`, `pdftotext -raw` (for signal 2) and `pdftohtml -xml -i -f 1 -l 1` (the outline). All are in `poppler-utils`.
4. **Plain paragraphs only**; no footnote handling in the first version (the heuristic misfires, and books with footnotes fail the gate anyway).
5. **Hyphens:** join unless the compound occurs elsewhere in the book.
6. **Header and footer rule as in the spike:** top 15 % and bottom 20 % of the page, recurring on three pages, at a height that mostly holds recurring text.
7. **Store the extracted sentences; never re-extract silently.** Keep the result on disk with the PDF's fingerprint and a pipeline version, as the prepared text of step 2 is cached. Alignment maps and bookmarks hang on these ids.
8. **Run poppler as a child process with a time limit and a memory limit**, reading its output as a stream. One scan took 15 s; a limit of two minutes leaves room. PDFs are untrusted input and poppler has a long record of parser bugs: a separate process is the right boundary, and it must get the file path only from a stored edition record, as the media proxy does.

### 5.3 Would sentence ids be stable?

- **Same PDF, same poppler:** yes. Two runs gave byte-identical output for all 22.
- **Newer poppler (22.12 → 25.03):** identical sentences and ids for 19 of 22, among them all four that pass the gate and all three of the owner's. The three that differ are OCR scans, by one to five sentences each.
- **Why pages as sections:** with one section per book, those few differences shift every later id; only 28 % (p17) and 54 % (p16) of the ids still named the same sentence. With a section per page, 99.7 % and 99.9 % did. A page is the one anchor a PDF has that no extractor moves.
- The ids also depend on the ICU data of the Node version, through `Intl.Segmenter`. That is true for EPUBs today and is not new.

### 5.4 What the Docker image needs

- `poppler-utils` in the runtime stage's existing `apt-get install --no-install-recommends` line: 32 packages, 11.3 MB to download, 28.9 MB on disk, poppler 22.12.0 from Debian's security archive.
- **Nothing else for text.** No fonts, no `poppler-data` (only needed for some CJK PDFs), no word list.
- It runs under the read-only root filesystem: `pdftotext`, `pdftohtml -stdout` and `pdftoppm` were run with `--read-only`, `--network none` and 256 MB, writing to standard output.
- `scripts/image-smoke.mjs` should call `pdftotext -v`, so an image without the package fails the smoke check instead of failing at the first PDF.

## 6. Reading sync, and step 9

**Reading sync with a PDF that passes the gate.** The evidence does not argue against the decision. The owner's novel passes and its sentences equal the EPUB's for 99.2 %, in the same order; an alignment against that text would differ from one against the EPUB in under one sentence in a hundred. Three conditions follow from the findings: the ids must be frozen as in §5.2 point 7; where a work has an EPUB as well, the EPUB should stay the edition (it has the words the PDF silently lost, and its structure); and a PDF that fails the gate must never be offered. No alignment was run in this spike, so the claim rests on text equality, not on a measured sync.

**Step 9, from the scans in the sample.** Six of the 22 are scans, and all six fail the text gate, the four with an OCR layer included, so step 9 is what serves every scan, the owner's too. `pdftoppm` is in the same package. It rendered a scanned page at 150 dpi in 0.2–0.25 s with under 22 MB, which is fast enough to render on demand. A rendered page is far larger than its source: 170–220 KB as JPEG at quality 80, against 10–14 KB for the same page as JBIG2 inside the PDF, so 718 pages come to about 140 MB. That means a bounded cache, not a full pre-render, and Keep on this device should store the PDF rather than the images. Scanned pages are small (the owner's is 393 × 580 pt), so 150 dpi gives about 820 px across, enough for a phone held upright; zooming needs a second, higher render. `pdftoppm` wants a writable fontconfig cache or it warns on every call, and a PDF whose fonts are not embedded needs `fonts-urw-base35` (15.6 MB) to look right; scans do not. The saved place would be a page number, which the reader does not have today (positions are CFIs and sentence locators), so step 9 needs its own position kind. An OCR layer, where present, is good enough to search a page (95 % of the owner's sentences are right) though not to read along.

## 7. The spike's scripts

In [`pdf-text-extraction/`](pdf-text-extraction/). They are throwaway: nothing imports them, and step 8 should be written fresh from §5 with tests. They run without dependencies.

| File | What it does |
|---|---|
| `extract.sh` | In a container with `poppler-utils`: the four `pdftotext` modes, `pdfinfo` and the outline for every PDF in `/in`, with time and peak memory. |
| `pipeline.mjs` | Builds paragraphs and sentences for the three reading orders and writes the measures. |
| `truth.mjs` | Scores a built book against an EPUB or a Project Gutenberg text. |
| `stability.mjs` | Compares two extractions of the same PDFs, with outline sections and with page sections. |
| `gate.mjs` | Prints the gate's signals and the cost for every book. |

```sh
docker build -t pdfspike - <<'EOF'
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils time unzip
EOF
run() { docker run --rm --network none -v "$IN":/in:ro -v "$OUT":/out -v "$PWD/docs/research/pdf-text-extraction":/spike:ro pdfspike "$@"; }
run /spike/extract.sh
run sh -c 'for d in /out/*/; do node /spike/pipeline.mjs "$d"; done; node /spike/gate.mjs /out'
```

The PDFs, the extracted text and the owner's files are not in the repository. The public PDFs came from planetebook.com, supremecourt.gov, irs.gov, nvlpubs.nist.gov, greenteapress.com, eloquentjavascript.net, the `progit/progit2` releases, web.mit.edu, arxiv.org, cdc.gov, gao.gov, pubs.usgs.gov and archive.org (identifiers in §2); the ground-truth texts are Project Gutenberg's 1342, 2701, 1400 and 2009.

## 8. Limits of this spike

- 22 PDFs, of which three are the owner's and four pass. The gate's thresholds fit this sample.
- English only. The splitter is fixed to English; no PDF in another language, and none with right-to-left or CJK text, was tried.
- No alignment was run, and nothing was rendered in the reader.
- The pipeline's heuristics are a first attempt. A better paragraph builder might rescue some technical books; it would not rescue the scans, whose limit is the OCR layer (§3.1).
