# Plan: build and ship the interface redesign

**Shipped (2026-11-19).** The redesign is finished: slice 14 ("Remove what is left", spec #608) was the last, and the deploy of its final ticket put it on production. The plan below is kept as the record and not updated.

Written 2026-11-16, and revised the same day after the owner settled its decisions in three rounds of `/grill-with-docs` (49 questions, section 0.1). It turns the design on the canvas into shipped code, in slices that are each deployed on their own. Nothing here is started.

- Design, 40 boards: https://claude.ai/artifact/KuDN2X7UM7jAMyq76HmBeL (private to the owner; version 17 shows the decisions below).
- Design source and its handoff: `/home/jahn/audiobook_streamer/artifacts/design/redesign-2026-11-15/` (`HANDOFF.md` first; boards in `project/`; every tooltip text in `tools/tips.mjs`). The folder is not in git yet; step 0.3 below changes that.
- Process: this repo's main flow in `AGENTS.md`. The effort is too large for one session, so it starts with `/wayfinder`.
- Terms: `GLOSSARY.md` (Reading sync, Prepare again, Narration highlight, Pages mode, Scroll mode, Face, Keep on this device, Device save, In progress, Finished). Decision records: ADR 0017 (one reading view in two modes), ADR 0018 (Keep on this device), ADR 0019 (nothing over the book's text), and the status note on ADR 0002.

## What is being built

| Area | What changes | Replaces |
| --- | --- | --- |
| Language | Tokens (three corners, six spacing steps, five text styles, three heights), one row, tooltips, one vocabulary | Twelve corner radii, about twenty names for the same places and states |
| Book | A page per book: Listen, Read, Files (Audiobook, Ebook, Reading sync), Keep on this device, Hardcover | The book dialog, Versions & sources, the release select, Find ebook |
| Audiobook, Ebook | A page each, same shape: choose a recording or edition, see where it is available from | `MediaManager.tsx`, the ebook shelf and set list in Discover |
| Get | One sheet for a recording or an edition | The release picker, the magnet and import dialog, the ebook search |
| Reading sync | A page per book: the pair, the steps, the result, the reason when it stops | The card inside the reader's More sheet |
| Activity | Now, This device, Server | The Downloads page, the Activity page, Settings › Reading sync |
| Series | A page with the books in order, each opening its book; an Add sheet; a Library filter | The series dialog |
| Now playing and reader | Two faces of one screen, Listen and Read; pages mode or scroll mode; controls in the page's head and foot | The expanded player and its sheets, the reader's top bar and More sheet, the Lyrics and Word views |
| Discover | Finds books; files are found inside Get | Searching AudioBookBay, Prowlarr and Library Genesis from Discover |
| Shell | Library, Discover, Activity, Settings on phone and desktop; Settings as a list with detail pages | The drawer, the profile button, the shelves list, one long Settings scroll |

Four things are behaviour, not layout: the narration highlight stays until the next sentence starts; the page turns inside a sentence that crosses it; Keep on this device is one standing switch per book; a book with only an ebook is in the Library.

## How it ships

**Screen by screen in the live app, no long-lived branch and no second interface behind a switch.** Each slice builds one new screen from the shared parts, removes what it replaces, passes the committed check, is reviewed, and is deployed. For a few weeks the app mixes old and new screens. That cost is accepted because every slice is small enough to review and every deploy has a one-command rollback.

A switch between an old and a new interface was considered and rejected: it doubles the browser tests and keeps both alive until the end.

The server stays tolerant of older open clients throughout: responses only gain fields, and no route changes its shape. No slice changes a database table (see Books without audio in 0.1).

## 0. Before any code

### 0.1 Decisions (settled by the owner, 2026-11-16)

**How the effort runs**

- Screen by screen, no switch (above). The order is in "Order" below.
- Deploys have a standing go-ahead: each slice is deployed after its check and review without asking first, never while the owner is listening. Should a slice turn out to need a table change after all, that deploy waits for the owner's word.
- Whoever builds a slice checks it on production with the owner's books: the live checks plus a pass by hand, with screenshots in the ticket. The owner's own look does not hold the next slice; what he finds becomes a new ticket.
- Boards that do not exist yet are drawn shortly before their slice and published to the canvas. The slice starts after the owner's OK (0.4).
- Every screen slice ships the phone and the desktop layout together. A page with no desktop board is the phone layout in one centred column beside the rail. The desktop layout starts at 760 px, as today; anything narrower gets the phone layout.

**Names on screen**

- "Reading sync" is the only name for it on screen, also in Activity ("Reading sync queue", "Reading sync worker").
- The manual action is "Prepare again". The map in use stays in use until the new one is ready.
- The screen says Audiobook, Ebook, Files, Recording, Edition, Server, This device, Get. `GLOSSARY.md` keeps its own terms for these (audio edition, ebook edition, delivery source).
- The reader's two modes are Pages and Scroll, on a row labelled "Reading mode".
- A queue that is switched off reads "Paused". A worker that is switched off reads "Not in use".
- All 51 tooltips are built. They are pruned later, from use.

**The four places**

- Activity takes the Downloads slot in the navigation. It stays the administrator's view of the server's work. A device save is not an activity (`GLOSSARY.md`), but Now lists this device's saves next to the activities.
- Someone who is not the administrator sees Now (their own device saves) and This device, and no Server. Production has one user, so this is built plainly and checked by tests.
- Each queue has an on/off switch. The attention dot lights for failed or stuck activities and for a process that is down (administrator), and for a failed save on the device in hand (anyone).
- Library chips: All, Series, In progress, Not started, Finished, On device, Favorites. "In progress" replaces "Listening": a saved place in a recording or an ebook that is not the end. Finished follows ADR 0002. The Hardcover shelf and Hardcover list filters move into the Library's one sort-and-view control.
- A Library entry is any work the user added, whatever it has so far: nothing yet, audio, an EPUB, or only a PDF. A PDF-only book has Read switched off and its Ebook row says "PDF · opens in another app". The one ebook on today's shelf whose book is not in the library joins it when this ships.
- Discover finds books, not files. Results are works from Hardcover and the shared catalogue. A result opens its Book page with "Add to library", and its Files rows offer Get. AudioBookBay, Prowlarr and Library Genesis are searched only inside Get. Series search stays. When nothing matches, the last row is "Search for a recording of '…'", which opens Get and makes the book from the chosen recording.
- Settings has no Reading page. "Reading mode" and "Follow the narration" are a Reading group in Settings › Playback; theme, font and size are in Appearance.

**The book**

- The Book page keeps a description collapsed to three lines. Chapters are reached through the Chapters page. No rating.
- Hardcover is one row showing the shelf. It opens a page with shelf, lists, matching, the Hardcover edition and Use Hardcover position.
- The series line shows for any work with series information. A series that is not saved opens the same Series page with "Save series" as its main action. In the Library, series are a filter chip.
- **Keep on this device** (ADR 0018): one switch per book and device. It covers the chosen recording, the chosen EPUB and the map for that pair, and keeps itself true: later arrivals are saved without a tap, and an interrupted save resumes, also on mobile data. A changed recording is saved and the earlier copy stays until removed. Off asks once with the total size and removes every file of the book from the device; the place, bookmarks and library entry stay. A book is never shown as kept while a file is missing ("Not complete · 8 of 12 files", Retry, out of the On device filter, under Needs attention). The switch works before any file exists ("Nothing to save yet"). A PDF is never saved by it. At rollout, a recording that is completely or partly on a device starts with Keep on.
- **Books without audio** (status note on ADR 0002): no table changes. A book without audio is in the library through a placeholder audio edition, as 35 of the owner's 71 library books are today (7 of them with an ebook). An ebook-only book gets one the same way. The new screens ask the server for books by work and are addressed by work (`#book/<workId>`). Moving library membership onto works is a separate effort after this one.

**Now playing and the reader**

- One reading view in two modes (ADR 0017). Accepted losses: starting the audio by tapping a line, reading at a set words-per-minute, the `P` key. `F` stays. "Correct this sentence's timing" leaves the interface; its endpoint stays.
- The narration highlight stays on the last narrated sentence with no time limit, until the next one begins.
- The page turn inside a sentence is estimated from the sentence's start and end, spread over its words, and may come about a second early or late. No per-word timing is added to reading sync. If the break cannot be read from the page reliably, the reader turns at the sentence's midpoint.
- Nothing is drawn over the book's text (ADR 0019). Controls stay until the text is tapped again; no timer. At rest the foot keeps a small Pause. The reading mode is the first row of Appearance. Speed and the sleep timer take the place of the foot's transport row, with Done. Every message while reading appears in the foot.
- Now playing opens on the face last used for that book on that device, Listen the first time. A book without an EPUB has no Read face and Read offers Get ebook. A book without a recording opens on Read, has no Listen face (Listen offers Get audiobook), no mini player, and a foot that shows the place in the book with a position slider where the transport would be.

### 0.2 Bring the canvas in line (done 2026-11-16, version 17)

The boards, `tools/tips.mjs` and the handoff show the decisions: Reading mode, Prepare again, Paused and Not in use, In progress, the highlight, the Hardcover row and the description on the Book page (new board "Book: further down"), and speed in the reader's foot (new board "Reader: speed"). The handoff's open questions became "Decided by the owner". Published through the interactive terminal session (handoff, "Publishing a change"); the canvas had no comments and no hand edits.

### 0.3 Put the design in the repo

The first pull request copies the boards, `canvas.json`, the tools and the handoff to `docs/design/redesign/` (about 1 MB of text). Tickets then name a board file, and a worker in a fresh worktree has it. The canvas stays the place where the owner reviews; `docs/design/redesign/README.md` says how to publish to it.

### 0.4 Close the design gaps before each slice

Not everything is drawn. "Draw first" is drawn shortly before the slice, published, and the slice starts after the owner's OK. The rest follows today's behaviour with the new parts.

| Slice | Draw first | Follows today's behaviour |
| --- | --- | --- |
| S6 Activity | Empty and offline states; what someone who is not an administrator sees; a failed device save under Needs attention; a queue that is Paused, a worker that is Not in use | Prepare for all books (its counts and button) |
| S7 Book | The Hardcover page; a book that is not in the library yet (Add to library); a book with nothing yet; a PDF-only book | Where to resume when switching recording; the sheet of one copy; the fault report |
| S8 Get | Nothing new | A failing source, Load more, the magnet and import sheets |
| S9 Reading sync | Paused, cancelled, partly ready, language not supported; Prepare again while the current map stays in use | The Details page |
| S10 Keep | Turning Keep off; Not complete with Retry; Nothing to save yet; an earlier recording's copy; storage full | Nothing |
| S11 Series | A series that is not saved yet; works without a number; the New mark; removing a series | Errors |
| S12 Reader | Search and Bookmarks pages; speed and the sleep timer in the foot; messages in the foot; an ebook-only book; Listen on a desktop | Nothing |
| S13 Shell | Discover (search, results as books, "Search for a recording of '…'"); the sort-and-view control with the Hardcover filters; Settings detail pages (Appearance, Account, Users, Library and storage, App); sign-in and join | The other theme presets and the compact density, which the tokens already cover |

### 0.5 Map, spec, tickets

`/wayfinder` opens the map issue with this plan as its notes. `/to-spec` publishes the spec; `/to-tickets` files one ticket per slice below (larger slices as several), each naming its boards, with blocking links, labelled `needs-triage` and listed on roadmap #11. `/triage` releases them.

## Slices

Sizes are relative: S is a day's worth of worker time, M a few, L a week, XL more and split further in its tickets. Paths are where the work lands today.

### Foundations

**S1. Tokens, parts and routes (L).** Nothing visible changes.
- Tokens: the colours already exist as variables in `src/appearance.css` (`--background`, `--surface`, `--raised`, `--border`, `--text`, `--muted`, `--accent`) and stay the single source for every preset and the custom palette. Add spacing, the three corners and the three heights.
- Parts in `src/ui/`: Row, Group, Button, Chip, Segmented control, Switch, Stepper, File row, Book row, Choice row, Steps, Tooltip, Page header, Sheet. The tooltip needs a popover that closes on a tap outside and opens on hover and focus; add `@radix-ui/react-popover` next to the dialog already in use.
- Routes: today's hash routes are flat names. Add parameters and a page stack (`#book/<workId>`, `#book/<workId>/audiobook`, `#series/<id>`, `#activity/server`), with the phone's back gesture closing a page. Move the page switch out of `App.tsx` (3,058 lines) into `src/pages/`, because S6, S7, S8, S11 and S13 would otherwise all edit that one file.
- Server: one read of the user's library by work (each work with its audio edition and recordings, its ebook editions, its reading sync and its series line), next to `GET /api/books`, which stays for older clients.
- Check: a gallery page used only by the browser tests, with a spec that measures the parts in every preset (heights 44, 52, 56, 64; corners 8, 14, round; touch targets; names for screen readers).

**S2. One vocabulary (M).**
- `src/status-lines.ts`: pure functions from a download, a server copy, an ebook-set member, an alignment job and a device save to its line. Unit tests walk every status the server can write (`ACQUISITION_STATUSES`, `SERVER_COPY_STATUSES`, the member statuses and hold reasons, `ALIGNMENT_STATUSES` and the whole-book worker stages). The mapping is in the handoff under "One vocabulary", plus "Paused" for a queue that is off and "Not in use" for a worker that is off.
- `src/tips.ts`: the tooltip texts, from `tools/tips.mjs`.
- Server labels that reach the screen change with it (`server/*-activity.ts`: "Alignment processor" becomes "Reading sync queue", "Alignment worker (wsl)" becomes "Reading sync worker (wsl)", "Alignment map" becomes "Reading sync"). The pause explanations (`PAUSE_EFFECT`) stay in the response and become the tooltips.
- The production image copies only four files of `src/` (`types.ts`, `series-selection.ts`, `appearance.ts`, `reading-types.ts`). Neither new module may be imported by the server.

### Reader behaviour

These need no new screen, run beside the foundations, and are the first things the owner will notice.

**S3. One reading view (M).** ADR 0017. Remove Lyrics and Word: `LyricsReader.tsx`, `WordReader.tsx`, `lyrics-lines.ts`, `lyrics-window.ts`, their styles, the switch in the More sheet, Ebook view and Words per minute in Settings, the `p` case, and "Correct this sentence's timing" in `ReadingSync.tsx` (its endpoint stays). `F` stays. Keep the word-time interpolation in `word-timing.ts` for S5. The saved fields `reader.display`, `segmentWords` and `wordWpm` stay accepted and are ignored, because an older open client still sends them. Deletes the `word-reader`, `lyrics-measure` and `lyrics-window` specs (about 890 lines) and edits the four others that name Lyrics.

**S4. The highlight stays until the next sentence starts (S).** In `Reader.tsx` the highlight is removed when no interval covers the position (the branch that calls `annotations.remove` when `!interval`). The narrated sentence becomes the last one that started at or before the position, with no time limit, decided in `reader-following.ts` (ADR 0014) so one module owns it. Unit tests for a silence, a passage the ebook does not have, a jump into a gap and the start of a new audio file; one case added to `reader-follow-highlight.spec.ts`.

**S5. A sentence across two pages (L).** Today the reader shows the page where the sentence starts and stays there. Find where the sentence breaks (the first word whose box lies on the next page), take that word's time from the interpolation, and turn then. Recompute when the font, the size or the window changes. A pause keeps the page; a page turned by hand turns nothing until Back to narration. The turn is an estimate and may be about a second early or late; that is accepted. This is the riskiest single item: epub.js lays pages out as columns and the break has to be read from the rendered boxes. If it cannot be read reliably, the reader turns at the sentence's midpoint. It gets a fixture with a sentence that is known to cross a page at 390 by 844 with the bundled Literata, and a check on production with one of the owner's books.

### New screens

Each replaces the old screen in the same change, ships its phone and desktop layout together, and ships its tooltips (S2 holds the texts).

**S6. Activity (L).** `#activity` with Now, This device, Server; `#downloads` redirects there; the navigation's Downloads entry becomes Activity and takes the attention dot from Settings.
- Server: `GET /api/activity` items gain `workId`, `bookId` and `cover` so Now can group by book. It stays administrator-only; someone else sees their own saves in Now and This device, and no Server.
- Now lists the server's activities and, from the device's own records, this device's saves. A failed save lights the attention dot for anyone.
- Server: each queue is a row with a switch (the pause that exists today); off reads "Paused", and a worker that is switched off reads "Not in use".
- Replaces the Downloads page and `AcquisitionQueue`, `Activity.tsx`, `ReadingSyncSettings.tsx` and `AlignmentPoolStatusView.tsx`. This device works offline from the device database, as Downloads does today.
- Specs: `activity`, `device-downloads`, `torrent-health`, parts of `app` and `offline-restart`.

**S7. Book, Audiobook and Ebook pages (XL, four tickets).** `#book/<workId>` and its sub-pages replace the book dialog, `MediaManager.tsx`, the release select and `ReaderShortcut`'s chooser. Recording and delivery source stay visibly separate (ADR 0015 keeps the choice in one module). The Book page keeps a description collapsed to three lines; no rating; chapters through the Chapters page. Hardcover is one row and a page of its own (shelf, lists, matching, the Hardcover edition, Use Hardcover position). A book that is not in the library yet shows "Add to library". Specs: `source-progress`, `releases`, `media-controls`, `hardcover`, `users` (what only an administrator may do), parts of `app` and `position-history`.

**S8. Get (L).** One sheet component with two data sources; replaces `ReleasePicker.tsx`, the import and magnet dialog and the search half of `EbookDiscovery`. AudioBookBay, Prowlarr and Library Genesis are searched here. Discover itself keeps working as today until S13. Specs: `releases`, `prowlarr`, `discovery`, `series-release-search`.

**S9. Reading sync page (M).** `#book/<workId>/sync` replaces the card in `ReadingSync.tsx`; the steps come from the whole-book job's stage. The manual action is "Prepare again", and the map in use stays in use until the new one is ready, as the automatic rebuild already does (`published_map`); bring the manual route in line where it does not. Jobs of the older window engine keep working and show a plain progress line; their chapter matcher is not carried over (production runs whole-book jobs; confirm with the open leftovers of #405 before deleting it). Specs: `reading-sync-book-jobs`, `reading-sync-resume`, `chapterless-sync`. Live check: `verify-reading-sync.mjs`.

**S11. Series (M).** `#series/<id>` replaces `SeriesDialog`; the Add sheet is the Get sheet's shape with several choices; a line on the book page for any work with series information; a series that is not saved opens the same page with "Save series"; a Series chip in the Library. Server routes exist. Specs: the five `series-*` files.

**S10. Keep on this device, and books with only an ebook (L, two tickets).** After S7, S8 and S9.
- Keep (ADR 0018): a setting per work in the device database (a new Dexie version, additive). It drives the existing chunked audio download (`media-download.ts`), the existing offline EPUB save and the map cache, and reconciles whenever Sonder is open: saves what is missing, resumes what was interrupted, and reports "Not complete" when a file is gone. A recording that is completely or partly on the device starts with Keep on. Off asks once with the total size and removes every file of the book, an earlier recording's copy included.
- Books with only an ebook: no table changes. An ebook-only work gets a placeholder audio edition, as a Hardcover shelf book has today (one function decides what a placeholder is, in place of the `hc-` prefix checks). The Library lists it with cover marks for what it has; "In progress" and Finished take the ebook's place into account; a PDF-only book has Read switched off. The ebook shelf in Discover goes, and the one shelf ebook whose book is outside the library joins it.
- Specs: `device-downloads`, `offline-restart`.

**S12. Now playing and the reader's page (XL, five tickets).** After S3, S4 and S5. ADR 0019.
- a. Listen: the redrawn Now playing, with the sleep timer as a row and Chapters as a page. It opens on the face last used for that book on that device.
- b. The page: a head of 44 and a foot of 72 that keep their height whether the controls show or not, plus the safe areas of a phone. The epub.js view is sized to the text band once and not again on a tap. Controls stay until the text is tapped again. At rest the foot keeps the progress line, the time left and Pause.
- c. Appearance docked under the text, with Reading mode (Pages, Scroll) as its first row; the view is laid out again in what is left and keeps the narrated sentence in view.
- d. Chapters, Bookmarks and Search as pages; speed and the sleep timer in the foot in place of the transport row, with Done; every message in the foot; the More sheet removed.
- e. A book without a recording (Read only, the place and a position slider in the foot, no mini player) and a book without an EPUB (Read offers Get ebook).
- f. Desktop: contents beside the text, page arrows in the margins, the player as footer.
- A spec asserts the rule itself: in every state the boxes of the head, the foot and any docked panel do not intersect the box of the text.
- Specs: `now-playing-layout`, `integrated-reader`, `reader-frame`, `reader-theme`, `back-to-narration`, `playback-workflow`, `media-controls`, `playback-speed`, `playback-speed-rate`, `position-history`, and the phone projects.
- Live checks: `verify-integrated-reader.mjs` and `verify-playback-workflow.mjs` drive these screens and are run by every deploy. They change in the same pull request and are run against a local test server first (`SONDER_VERIFY_URL`).

**S13. Library, Discover, Settings and the shell (XL, five tickets).**
- Library: the chips (All, Series, In progress, Not started, Finished, On device, Favorites), one sort-and-view control that also holds the Hardcover shelf and Hardcover list filters, one add button.
- Discover: finds books. Results are works from Hardcover and the shared catalogue; a result opens its Book page; "Search for a recording of '…'" is the last row and opens Get. Series search stays.
- Settings as a list with detail pages, side by side on a desktop; Reading mode and Follow the narration as a Reading group in Playback.
- The drawer and the profile button removed; the desktop rail; sign-in and join in the new parts.
- Depends on the boards from 0.4. Specs: `app`, `users`, `join`, `account-requests`, `hardcover-sync-form`, `device-reset`, `pwa-shortcut`, `discovery`.

### After the last screen

**S14. Remove what is left (M).** Components nothing imports, the rules in `src/styles.css` (8,468 lines) whose classes are gone, the README sections that describe the old screens (Listening workflow, Ebook sources, the reader, Activity), the Client paragraph of `CLAUDE.md`, the keyboard help. A unit test fails when a stylesheet uses a corner or a spacing value outside the tokens, so the language cannot drift again.

## Order

```
0   canvas in line ─ design in repo ─ map, spec, tickets
1   S1 parts and routes, S2 vocabulary             nothing visible
2   S3 one view ─ S4 highlight ─ S5 page turn      beside step 1
3   S6 Activity ─ S7 Book, Audiobook, Ebook
4   S8 Get, S9 Reading sync, S11 Series
5   S10 Keep, books with only an ebook
6   S12 Now playing and the reader's page
7   S13 Library, Discover, Settings, the shell
8   S14 removal
```

- Steps 1 and 2 run side by side; S1, S2 and S3 share no files.
- The owner's focus, the processes and the files, is on screen by step 3. S7 may start while S6 is in review, once S1 has moved the pages out of `App.tsx`.
- S12 is the largest and touches the files S4 and S5 change, so it starts only when both are merged and proven on production.
- S13 is last among the screens because every other screen removes something from the shell first.
- Workers are chosen per ticket as `AGENTS.md` says under "Spawning subagents": S5, S12b and S10's Keep need the most capable model; S2, S3, S14 are mechanical. Keep a wave to three or four workers.

## Checks for every slice

1. Tests written with the change: unit tests for logic, a browser spec for the behaviour, and for a screen a measurement against its board (heights, order of rows, the names on it).
2. `npm run ci:run <sha>` on the committed revision. The browser suite is about 9,500 lines in 42 files; most of its files drive a screen that changes, so every screen slice budgets for rewriting its specs, not only for the screen.
3. `/code-review` with every finding fixed or answered, then the pull request with screenshots at 390 by 844 and at desktop width, next to the board.
4. After the deploy, whoever built the slice checks it on production with the owner's books: the live checks plus a pass by hand of what the ticket lists, on a phone-sized window and a desktop one, with screenshots in the ticket. Fixtures alone do not count in this repo. The owner's own look is welcome and does not hold the next slice; what he finds becomes a new ticket.

## Deploying

One deploy per merged slice, by the documented route only, with the owner's standing go-ahead for this effort:

```bash
npm run ci:run <sha>                                  # committed check; use --full before a deploy
scripts/deploy-prod.sh <sha> --marker '<a string only this slice adds>'
```

- The script backs up the database, tags the running image for rollback, builds, checks the marker in the image, smokes it, recreates the container, waits for health and runs the live checks. It prints the rollback command; record the deploy in `artifacts/orca/STATE.md`.
- Rollback is retagging the previous image and recreating without a build. No slice changes a table, so the older image runs on the same database. A slice that turns out to need a table change keeps it additive, and its deploy waits for the owner's word.
- Do not deploy while the owner is listening: the live checks select a recording, and the multi-user check has tripped on that before.
- An open older client keeps working against the newer server and is told an update is ready (`AppUpdate.tsx`). Check this once per deploy by leaving a tab open across it.
- The alignment workers on WSL and lisa are not touched by any slice. Do not run `scripts/install-ctc-workers.sh` for this effort.
- S12 and S9 change what the live checks click. A deploy whose live check fails because the script still expects the old screen is a failed deploy; fix the script in the slice, not afterwards.

## Risks

| Risk | What limits it |
| --- | --- |
| The page turn inside a sentence depends on how epub.js lays out columns | S5 is its own slice with a fixture; the agreed fallback is to turn at the sentence's midpoint, which is still better than today |
| A fixed head and foot on phones with a notch or a home bar | S12b measures with the safe areas in the phone projects and on a real phone |
| Keep on this device and browser storage that can be cleared | S10 shows Protected storage and what was lost, and never shows a book as kept while a file is missing |
| Keep saves on mobile data without asking | Accepted with the decision; the save shows in Activity while it runs, and the switch is the statement of intent |
| A mix of old and new screens for weeks | The order puts the most used path first: reader behaviour, Activity, Book |
| Browser tests rewritten wholesale lose what they guarded | Each slice lists the behaviours its old specs covered and keeps a test for each |
| Gaps in the design stall a slice | 0.4 lists them per slice; a slice does not start until its "draw first" boards have the owner's OK |
| A worker edits `App.tsx` while another does | S1 moves the pages out first |
| Removing Lyrics and Word is not easily undone | ADR 0017 records it; the code stays in git history |
| The placeholder for books without audio gets one more use | One function decides what a placeholder is; the status note on ADR 0002 names the later effort |

## Done

- Every screen in the table at the top is built from the shared parts, and its old screen is deleted.
- The four behaviours hold in production with the owner's books.
- `src/styles.css` has no corner or spacing value outside the tokens, and the check that enforces it is in the suite.
- README, `GLOSSARY.md`, `CLAUDE.md` and the ADRs describe the new app; roadmap #11 lists the effort as finished.

## Next step

The owner confirmed the decisions in 0.1 on 2026-11-16, and the canvas is in line (0.2). Next: `/wayfinder` with this file as its notes.
