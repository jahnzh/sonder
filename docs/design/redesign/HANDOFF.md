# Handoff: Sonder interface and settings redesign

Written 2026-11-15 (first draft), revised three times on 2026-11-16 (second round: files, reading sync, Activity; third: tooltips and series; fourth: Now playing and the reader; fifth: the owner's decisions) for whoever refines this design next. It is a design on a canvas; nothing is built in the app.

**The owner has decided.** On 2026-11-16 he settled every open question in three rounds (49 questions, all accepted). The decisions are in the app repository: `docs/REDESIGN_PLAN.md` section 0.1, `GLOSSARY.md`, and ADR 0017 (one reading view in two modes), ADR 0018 (Keep on this device), ADR 0019 (nothing over the book's text) with a status note on ADR 0002. On that day these were uncommitted on branch `jahnzh/redesign-alignment-download-ui` (Orca worktree `goldfish`). Where this handoff and that plan differ, the plan is right.

## The brief (owner's words)

First:

> redesign the main interface and the settings. There is no design language currently, it's all cobbled together. I need the user experience to be more cohesive. Different UI elements need to be well aligned. The number of different menus should be reduced.

Second, on 2026-11-16, after the first draft:

> I also mostly want to focus on UIs for the alignment processes, and media download management. Ebook and audiobook files should be more cohesive in user experience instead of disjoint as they currently are. It needs to be more intuitive

Third and fourth, the same day, before the second round reached the canvas:

> There also need to be tooltips to explain entries where sensible. It's not necessary to show me visuals in line. I can just view and comment on the web interface of claude design.

> Also I need a cohesive way to display book series and link to member titles

Fifth, after the third round was on the canvas:

> Revise the media player and ebook reader UI as well. Keep only the pages reading mode. I want to switch between pages mode and scroll mode. Text should never be covered by toggleable ui elements. Take care when a phrase wraps a page. The highlights should not disappear in gaps between phrases. Just display the current highlight until the next starts.

The owner has not commented on a single board yet; his decisions came from questions, summarised under "Decided by the owner" below. He reviews and comments on the canvas, not in a chat.

## Where it is

- Canvas: https://claude.ai/artifact/KuDN2X7UM7jAMyq76HmBeL (private to the owner; a "Design" canvas artifact). **Since 2026-11-16 it shows all five rounds (version 17, 40 boards).**
- Who can reach the canvas: only an interactive Claude Code session has the canvas tool (`Artifact`), for publishing and for reading the owner's comments. An Orca chat session does not have it, and neither does `claude -p` (checked 2026-11-16: not in its tool list, not with `--tools Artifact`, not with a `/design` prompt). What worked: `orca agent launch --agent claude --surface terminal --prompt "<what to publish>"`. The session that published is the terminal "Sonder canvas" in the Orca workspace `goldfish`; it is subscribed to the canvas.
- `project/` in this folder: the current design, 40 boards plus `canvas.json`. It is what the canvas shows, unless the owner has edited the canvas since.
- `published-v9/project/`: the first draft as it was on the canvas (version 9). Diff against it to see what the later rounds changed; `tools/build.mjs` reads the first-draft boards from it.
- `preview/`: eight review pages to open in a browser, several boards per page, as rendered on 2026-11-16. They are snapshots; rebuild them after changing a board.
- `tools/`: `node check-boards.mjs` renders every board of `project/` in Chromium and reports anything clipped, cut off or malformed; with `--pages` it also rebuilds `preview/`. `build.mjs` with `lib.mjs` and `tips.mjs` (every tooltip text) is how the boards of the later rounds were first written; it writes to `tools/out/`, never to `project/`. The `.dc.html` files are the source of truth: once a board has been edited by hand, here or on the canvas, edit that file directly and do not rebuild it.
- The app being redesigned: `/home/jahn/audiobook_streamer` (repo `jahnzh/sonder`). Read its `CLAUDE.md`, `GLOSSARY.md` and the relevant `README.md` section before proposing behaviour changes.

### Publishing a change

How versions 11 to 17 went up, and how to send the next change:

1. Start (or reuse) an interactive Claude Code session as above. Give it the canvas URL, a root folder that holds `project/`, and the files to send. Tell it to update that canvas and never to create a new one.
2. It reads `project/canvas.json` from the canvas first. If the owner moved or renamed anything, keep that and change only your own entries.
3. It sends the changed boards, then `project/canvas.json` last and only when the layout changed.
4. The tool makes the session read every file before it sends it, and reading the canvas marks its boards as seen. So a hand edit the owner made on the canvas is **not** protected by a refusal: compare first when the canvas has a version you did not publish.

For versions 14 and 15 the session first listed the comments (none), then read `canvas.json` and each board it was about to replace from the canvas and compared them byte for byte with what it had published before (all identical). Versions 16 and 17 (the fifth round: 2 new boards, 19 changed ones, then `canvas.json`) went up the same way: no comments, and `canvas.json` and all 19 boards on the canvas were byte-identical to the last publish. Do the same next time; its copy of the last publish is `artifacts/canvas-publish/last-published/` in the `goldfish` workspace, which now holds version 17.

Before version 11 the canvas had a version 10 that nobody here published. Its `canvas.json` was byte-identical to version 9 and its eight boards had the same sizes to the byte, and there were no comments, so it was taken to be a save without changes. The tool cannot read an older version to prove it; the page's own version history can.

## What is drawn

| Board | File | Size | Round |
|---|---|---|---|
| Design language | `Main.dc.html` | 1280×1000, fixed | 1, "Where things live" updated |
| Design language: files and processes | `LanguageFiles.dc.html` | 1280×1000, fixed | 2 |
| Design language: tooltips | `Tooltips.dc.html` | 1280×1580, fixed | 3 |
| Design language: reading | `LanguageReader.dc.html` | 1280×832, fixed | 4, reworded in 5 |
| Library (phone) | `Library.dc.html` | 390×844 | 1, updated in 2 and 3 |
| Book (phone) | `Book.dc.html` | 390×844 | redrawn in 2, About in 5 |
| Book: further down | `BookMore.dc.html` | 390×844 | 5 |
| Now playing (phone) | `NowPlaying.dc.html` | 390×844 | redrawn in 4 |
| Settings (phone) | `Settings.dc.html` | 390×844 | 1, two rows moved out |
| Settings: Playback (phone) | `SettingsPlayback.dc.html` | 390×844 | 1, tooltips in 3, reading layout in 4 |
| Desktop: Library | `DesktopLibrary.dc.html` | 1280×800, fluid | 1, updated in 2 and 3 |
| Desktop: Settings | `DesktopSettings.dc.html` | 1280×800, fluid | 1, two rows moved out, tooltips in 3 |
| Book: files on their way | `BookGetting.dc.html` | 390×844 | 2 |
| Audiobook | `Audiobook.dc.html` | 390×844 | 2 |
| Ebook | `Ebook.dc.html` | 390×844 | 2 |
| Get audiobook (sheet) | `GetAudiobook.dc.html` | 390×844 | 2 |
| Get ebook (sheet) | `GetEbook.dc.html` | 390×844 | 2 |
| Reading sync: preparing | `ReadingSync.dc.html` | 390×844 | 2 |
| Reading sync: ready | `ReadingSyncReady.dc.html` | 390×844 | 2 |
| Reading sync: stopped | `ReadingSyncStopped.dc.html` | 390×844 | 2 |
| Reading sync: paused | `ReadingSyncPaused.dc.html` | 390×844 | #461 |
| Reading sync: cancelled | `ReadingSyncCancelled.dc.html` | 390×844 | #461 |
| Reading sync: partly ready | `ReadingSyncPartial.dc.html` | 390×844 | #461 |
| Reading sync: no text matched | `ReadingSyncNoMatch.dc.html` | 390×844 | #461 |
| Reading sync: not available | `ReadingSyncLanguage.dc.html` | 390×844 | #461 |
| Reading sync: preparing again | `ReadingSyncAgain.dc.html` | 390×844 | #461 |
| Reading sync: prepared again, not used | `ReadingSyncKept.dc.html` | 390×844 | #461 |
| Activity: now | `Activity.dc.html` | 390×844 | 2 |
| Activity: this device | `ActivityDevice.dc.html` | 390×844 | 2 |
| Activity: server | `ActivityServer.dc.html` | 390×844 | 2 |
| Worker | `Worker.dc.html` | 390×844 | 2 |
| Desktop: Activity | `DesktopActivity.dc.html` | 1280×880, fluid | 2 |
| Desktop: Activity, server | `DesktopActivityServer.dc.html` | 1280×880, fluid | 2 |
| Activity: now, empty | `ActivityEmpty.dc.html` | 390×844 | #458 |
| Activity: this device, empty | `ActivityDeviceEmpty.dc.html` | 390×844 | #458 |
| Activity: server, nothing running | `ActivityServerEmpty.dc.html` | 390×844 | #458 |
| Activity: now, no connection | `ActivityOffline.dc.html` | 390×844 | #458 |
| Activity: this device, no connection | `ActivityDeviceOffline.dc.html` | 390×844 | #458 |
| Activity: server, no connection | `ActivityServerOffline.dc.html` | 390×844 | #458 |
| Activity: now, not the administrator | `ActivityMember.dc.html` | 390×844 | #458 |
| Activity: this device, not the administrator | `ActivityDeviceMember.dc.html` | 390×844 | #458 |
| Activity: a save failed | `ActivityFailedSave.dc.html` | 390×844 | #458 |
| Activity: server, paused | `ActivityServerPaused.dc.html` | 390×844 | #458 |
| Worker: not in use | `WorkerNotInUse.dc.html` | 390×844 | #458 |
| Desktop: Activity, this device | `DesktopActivityDevice.dc.html` | 1280×880, fluid | #458 |
| Keep: turning it off | `KeepOff.dc.html` | 390×844 | #466 |
| Keep: not complete | `KeepNotComplete.dc.html` | 390×844 | #466 |
| Keep: nothing to save yet | `KeepNothing.dc.html` | 390×844 | #466 |
| Keep: an earlier recording's copy | `KeepEarlier.dc.html` | 390×844 | #466 |
| This device: storage full | `KeepFull.dc.html` | 390×844 | #466 |
| This device: cleared by the browser | `KeepCleared.dc.html` | 390×844 | #466 |
| Hardcover | `Hardcover.dc.html` | 390×844 | #460 |
| Hardcover: not matched | `HardcoverMatch.dc.html` | 390×844 | #460 |
| Book: not in the library | `BookNotInLibrary.dc.html` | 390×844 | #460 |
| Book: nothing yet | `BookNothing.dc.html` | 390×844 | #460 |
| Book: only a PDF | `BookPdf.dc.html` | 390×844 | #460 |
| Book: in a series | `BookSeries.dc.html` | 390×844 | 3 |
| Series | `Series.dc.html` | 390×844 | 3 |
| Series: add books (sheet) | `SeriesAdd.dc.html` | 390×844 | 3 |
| Library: series | `LibrarySeries.dc.html` | 390×844 | 3 |
| Desktop: Series | `DesktopSeries.dc.html` | 1280×940, fluid | 3 |
| Series: not saved | `SeriesNotSaved.dc.html` | 390×844 | #463 |
| Series: save (sheet) | `SeriesSave.dc.html` | 390×844 | #463 |
| Series: new from Hardcover | `SeriesNew.dc.html` | 390×844 | #463 |
| Series: further down | `SeriesMore.dc.html` | 390×844 | #463 |
| Series: remove | `SeriesRemove.dc.html` | 390×844 | #463 |
| Reader: pages | `Reader.dc.html` | 390×844 | 4 |
| Reader: controls shown | `ReaderControls.dc.html` | 390×844 | 4 |
| Reader: speed | `ReaderSpeed.dc.html` | 390×844 | 5 |
| Reader: scroll | `ReaderScroll.dc.html` | 390×844 | 4 |
| Reader: appearance | `ReaderAppearance.dc.html` | 390×844 | 4 |
| Reader: across pages, before | `ReaderWrapA.dc.html` | 390×844 | 4 |
| Reader: across pages, after | `ReaderWrapB.dc.html` | 390×844 | 4 |
| Chapters | `Chapters.dc.html` | 390×844 | 4 |
| Desktop: Reader | `DesktopReader.dc.html` | 1280×800, fluid | 4 |

All boards are static mock-ups. They link to each other (tab bar, rail, rows, back buttons, the Activity segments) so Play mode can walk through them. Every board has one tweak, the accent colour.

The sample books tell one story across the boards: *There Is No Antimemetics Division* has both files and a ready reading sync; *Snow Crash* is a new book whose audiobook is downloading and which has no ebook yet; *Feral Gods* is being prepared for reading sync; *Matter* stopped and is being saved to the phone, and is book 8 of *The Culture*, the sample series; *The Picture of Dorian Gray* waits for a worker; *Frankenstein* has only an ebook. The one break in that story: Now playing and the reader boards play and show *Frankenstein*, because the reader needs real text and that book is in the public domain, while the mini player on the other boards still names the first book.

## The design language

Kept from the app today, so it still looks like Sonder: the "forest" dark palette, the orange accent, Manrope for headings, DM Sans for everything else, Literata for book text only.

- **Colour:** ground `#101510`, surface `#182117` (group cards, bars), raised `#26331f` (controls, selected), line `#3c4934` (dividers only), text `#e6eadf`, muted `#a9b59d`, accent `#dd8966` (one main action per screen, play, and whatever is moving or needs attention). Destructive and failed text `#f2a79a`. Success tick `#a9d6a0`.
- **Type, five styles:** Title Manrope 700 28/34 (one per screen); Heading Manrope 700 20/26; Body DM Sans 400 16/22 (rows); Label DM Sans 500 14/20 (values, buttons); Caption DM Sans 600 12/16 uppercase, 0.08em (group names). A row's second line is 14/20 muted; notes under a group are 12/16 muted.
- **Spacing, six steps:** 4, 8, 12, 16, 24, 32. Screen edge 16 on a phone, 32 on a desktop.
- **Corners, three:** 8 (controls, covers), 14 (group cards, sheets), round (chips, play, switches).
- **Heights:** control 44, row 52, bar 64 (mini player, tab bar).
- **The row:** label on the left edge, value or control on the right edge, 16 inset, rows grouped in a surface card with a 1 px line between them.
- **Controls:** primary button (accent fill, dark text), secondary (raised fill), quiet (text only); filter chip; segmented control; switch (52×32); stepper.

Added in the second round (drawn on `LanguageFiles.dc.html`):

- **File row, 64 high:** a 20 px icon, the name, one status line under it, and a thin accent bar under the line while something moves. Three icons: headphones (audiobook), open book (ebook), chain link (reading sync).
- **Book row:** cover (40), title, then the same status line. Used wherever work in progress is listed.
- **Choice row:** two lines; the chosen one has the raised fill and a tick on the right edge.
- **Steps:** done (green tick), running (accent dot, bold label, bar), not started (ring, muted label). 36 high, no dividers.
- **One vocabulary** for files and work, see the next section.

Added in the third round (drawn on `Tooltips.dc.html`):

- **Tooltip:** an info mark (a circled i, 20 px, muted) after the name of a row, a group caption or a page title. A tap opens the explanation under the entry: light fill, dark text, 14/20, corner 8, at most 300 wide, with a pointer to the mark. One is open at a time; a tap elsewhere closes it. On a desktop it also opens on hover and keyboard focus.
- **When:** a word of the app, a switch whose effect its label does not say, or a figure that needs reading. Not on a name that says it all, and not for what must be read before acting: that stays on the page ("Keep Sonder open while saving", "Pause stops the worker").
- **Text:** one to three sentences: what it is, then what it does. A switch says what Off does. All 51 texts are in `tools/tips.mjs` and listed on the Tooltips board.
- **Name tooltip:** an icon without a label shows its name on hover, 12/16 on one line (drawn over the marks of a cover on the desktop Library).
- **Series row:** the book row with the book's number in front, 56 high. **Stacked cover:** three covers behind one another stand for a series.

Added in the fourth round (drawn on `LanguageReader.dc.html`):

- **The reader's page:** a head (44 high), the text, a foot (72 high). Controls appear only in the head and the foot. Both keep their height whether the controls are shown or not, so the text block never moves and nothing is drawn over it.
- **Book text:** Literata 18/29, 24 px side margin, whole lines only in the pages layout.
- **The mark:** the narrated sentence has the accent at about a quarter strength behind it, from its first to its last character.

## Structure as proposed

### Four places

Library, Discover, **Activity**, Settings; the same four on the phone (tab bar) and the desktop (rail). The first draft had three and put Activity inside Settings. Activity became a place of its own because the owner asked for the processes and downloads to be the focus. In exchange, three things left Settings (Activity, Offline copies, Reading sync) and the Downloads page stays gone. The attention dot moved from Settings to Activity.

### One book, two files, one sync

A book is a work with up to two files: an audiobook and an ebook. Both go through the same life: not added, on its way, on the server, kept on this device. Reading sync is the third line because it needs both.

- **Book page:** Listen and Read, then a **Files** group with three file rows in a fixed order: Audiobook, Ebook, Reading sync. Each row says what it is and where it stands in one line, and opens its own page. A missing file has a **Get** button in its row. Below: **This device** with one switch, Keep on this device, for the whole book. Further down (`BookMore.dc.html`): **About**, the description collapsed to three lines, then Hardcover (one row showing the shelf, which opens a page of its own), Mark as finished and Remove from library. No rating; chapters are reached through the Chapters page.
- **Audiobook page:** Recordings (choose one; Get another recording), Available from (Device copy, Server copy, Original stream), then Plays from and Report a problem. This is the Versions & sources dialog as a page.
- **Ebook page:** the same shape: Editions (each says how its check against the narration went), Available from, Export the file.
- **Get sheet:** one full-screen sheet for both formats: the book, a search field, a list of choice rows, Paste a magnet link or Import, one primary button. Only the facts in the rows differ.
- **Reading sync page:** the pair it is for (Recording, Edition), then its state: the steps while preparing, with Pause and Cancel; Ready with the share of text mapped, the unsynced passages and Prepare again (the map in use stays in use until the new one is ready); Stopped with the reason per worker and Resume. Engine, GPU use and stage times are behind Details.

### Activity

- **Now:** every book that has work in progress, as book rows in four groups: Needs attention, In progress, Waiting, Finished today. Downloads to the server, copies to the server, ebook checks, reading sync and saves to this device all appear here, each with the status line the book page shows. A row opens the book or its Reading sync page.
- **This device:** storage used, what is being saved now, and what is kept here, with a remove button per book.
- **Server** (administrator): the queues with a switch each (on runs, off starts no new work and reads "Paused"), Prepare for all books, the workers, the torrent client. A worker that is switched off reads "Not in use". A worker row opens the worker: status, device, current work, code version, Use this worker, Restart.
- On the desktop the list stays on the left and the chosen item opens beside it.

### Now playing and the reader

Now playing is one screen with two faces, Listen and Read, switched in its head. Both have the same transport.

- **Listen:** cover and title, the timeline, the transport, then two groups of rows: Speed, Sleep timer, Chapters; Plays from, Earlier positions, Keep on this device. The sleep timer is back (the first draft had lost it). Chapters is a page, shared with the reader, with Bookmarks beside it.
- **Read:** the book's own text and nothing else. The Lyrics and Word views are gone, and with them Words per minute and the words-per-line setting. There are two reading modes, Pages and Scroll; the row "Reading mode" is the first row of Appearance and of the Reading group in Settings › Playback, and switching keeps the place and the highlight.
- **At rest** the head shows the book and chapter, and the foot shows a thin progress line, the time left and Pause. **A tap on the text** shows the controls in the same two bands: Close, Listen or Read, Bookmark, Search and Appearance in the head; the timeline, Chapters, Back to narration, the 30-second skips, Play, Sleep timer and Speed in the foot. The More sheet is gone: its other entries live on the Book page (Reading sync, Keep on this device, recording and edition).
- **Panels:** Appearance docks under the text, and the text is laid out again in the space that is left. Speed and the sleep timer take the place of the transport row in the foot, with Done (`ReaderSpeed.dc.html`); the text is neither covered nor laid out again. What leads elsewhere (Chapters, Bookmarks, Search) is a page of its own. Every message while reading appears in the foot. Nothing opens over the text, and the controls stay until the text is tapped again.
- **Desktop:** the contents sit beside the text and push it; the player is the footer; page arrows sit in the margins.

Four rules for whoever builds it. The first two are what the owner asked for in so many words; today's code does the opposite of each (`src/components/Reader.tsx`).

1. **The highlight stays until the next sentence starts.** (`GLOSSARY.md`: narration highlight; the older texts here say "mark".) A sentence stays marked after its last word, through a silence, music or a passage the ebook does not have, until the next sentence's time begins. After a jump the marked sentence is the last one that started before the new position. Today the mark is removed as soon as no interval covers the position.
2. **A sentence across two pages.** Both parts are marked. The page turns when the narration reaches the first word on the next page; the sentence's time is spread over its words to find that moment, as the Word view did, so it is an estimate that may be about a second early or late (accepted; if the break cannot be read from the page, turn at the sentence's midpoint). It never turns at the start of the sentence and never waits for the next sentence while the narrator reads words that are not on screen. Today the reader shows the page where the sentence starts and stays there until the next sentence.
3. **Scroll while following** keeps the marked sentence in the upper half. A touch on the text stops the following; Back to narration resumes it, as today.
4. **Nothing covers the text:** see the page above. A message such as "Listening from here · Undo" appears in the foot.

### Series

A series is a page, not a dialog, and every member opens its book.

- **Series page:** the name, the author and how many are finished, then the books in reading order with the series row: number, cover, title, and the same status line as everywhere else (Finished, Not started, a chapter and time left, Finding a source, Not in your library). A book in the library opens its Book page; the one to continue is raised and has the play button; one that is not in the library has an Add button.
- **Add sheet:** the books that are not in the library as choice rows (several can be chosen), then Get the audiobooks, Get the ebooks and Preferred language, then one button. It is the Get sheet's shape.
- **Book page:** a book that belongs to a series says so under its author ("The Culture · Book 8") and that line opens the series.
- **Library:** a Series filter chip, second in the row (All, Series, In progress, Not started, Finished, On device, Favorites). It lists the saved series as rows with a stacked cover. On the desktop the list stays on the left and the chosen series opens beside it.

### Tooltips

See the design language above. They also took over text that the app shows all the time today: what pausing each background process does (`PAUSE_EFFECT` in `server/activity-pause-model.ts`) is now the tooltip of that queue's switch, and the note under Words per minute in Settings is that entry's tooltip.

### One vocabulary

| Word | Replaces in today's app |
|---|---|
| Server | HDD, 4 TB media drive, home server, Host server |
| This device | device cache, offline, saved here |
| Recording | version, release ("Versions & sources", "Use this release") |
| Edition | ebook edition, reading edition |
| Reading sync | also "alignment map", "alignment processor", "alignment worker" on the Activity page |
| Get | Find another release, Find ebook |
| Keep on this device | Save offline, Save on device, Save ebook offline |

Status lines, and the state they stand for:

- A file (`Acquisition.status`, `server_downloads`): Not added; Finding a source (`checking`); Preparing the stream (`preparing`); Downloading to server · N% (`downloading`); Copying to server · N% (a server copy); Paused · N%; On server (`ready`, local); Streams from TorBox (`ready`, TorBox); Download failed (`error`).
- An ebook against the narration (ebook-set member): Checking against the narration (`pending`); Matches the narration (`accepted`); Does not match the narration (`rejected`); Waiting for the audiobook (`awaiting_audio`); Waiting for a worker (`awaiting_worker`); Not checked, English only (`language_not_supported`); Check failed (`evaluation_failed`).
- Reading sync (`AlignmentJob.status` and the worker's stage): Needs an ebook; Waiting for a worker (`queued`); Copying audio (`copying`); Decoding audio, Encoding audio, Anchoring text to audio, Aligning text, Saving the map (`processing`); Paused; Ready · estimated timings (`ready`); Partly ready · N% of the text (`partial`); Stopped (`error`).
- This device: Saving · N of M files; On this device · size.
- A book in a series that the user has not added: Not in your library.

### What each place takes over

- Book › Files: the "Your audiobook release" block, the recording select, Save offline, Save to server and Find ebook in `BookDetail` (`src/App.tsx`), and the edition chooser in `ReaderShortcut.tsx`.
- Audiobook page: `MediaManager.tsx`.
- Ebook page: the ebook-set member list and "Your ebook shelf" in `EbookDiscovery` (`SourceWorkflow.tsx`), and Save ebook offline in the reader's More sheet.
- Get sheet: `ReleasePicker.tsx`, the magnet and import dialog, and the search half of `EbookDiscovery`.
- Reading sync page: the card in `ReadingSync.tsx`, today inside the reader's More sheet.
- Activity › Now: `AcquisitionQueue` on the Downloads page and the item groups of `Activity.tsx`.
- Activity › This device: "On this device" on the Downloads page.
- Activity › Server: the process list and worker controls of `Activity.tsx`, and `ReadingSyncSettings.tsx` (Prepare for all titles, the pool status).
- Now playing and the reader: `Player.tsx` (the expanded player and its three sheets), `Reader.tsx` with its top bar, More sheet, appearance panel and player bar, and the contents and bookmarks panels. `LyricsReader.tsx` and `WordReader.tsx` have no successor.
- Series page, Add sheet and the Series filter: `SeriesDialog`, `SeriesLibrary` and the per-book lines of `SeriesWorkStatus.tsx` (`src/components/Series.tsx`). Today the dialog lists the works but none of them opens its book.

## New behaviour drawn

Everything else on the boards gives a new home or a new name to something the app does today. These do not exist yet, or remove something that does:

1. **Keep on this device is one switch for the whole book.** It saves the chosen recording, the chosen EPUB and the reading sync map. Today these are separate one-time actions in different places.
2. **A book with only an ebook sits in the Library** (Frankenstein on the boards). Today a library row needs an audio edition, and other ebooks live on a shelf inside Discover.
3. **The reader loses two views.** Lyrics and Word are removed at the owner's request, with their settings (`reader.display`, `segmentWords`, `wordWpm` in `src/appearance.ts`). The More sheet goes too.
4. **The reader's bars no longer lie over the text,** the mark outlasts silences, and the page turns inside a sentence that crosses it (the four rules above).
5. **Covers show what a book has:** small marks for audiobook, ebook and a ready reading sync, or the percentage while its first file downloads.

## Not drawn yet

- In the reader: the Search and Bookmarks pages; the sleep timer in the foot (speed is drawn); messages in the foot ("Listening from here · Undo", an error, another session saved a different place, an update is ready); a book with only an ebook (no Listen face, its foot holds the place and a position slider, no transport); Listen on a desktop; the other three reader themes.
- Series: finding one in Discover (it opens the Series page, not yet saved: `SeriesNotSaved.dc.html`); the refresh error and the note that a work needs an administrator to link it.
- Tooltips on the pages that are not drawn yet (Appearance, Account, Users, Library and storage, the reader).
- Discover, which now finds books: results are works, a result opens its Book page, and the last row is "Search for a recording of '…'".
- The Library's sort-and-view control with the Hardcover shelf and Hardcover list filters.
- Choosing where to resume when switching recordings; the sheet of one copy (size, Save to server, Remove, Report a problem); the Plays from picker; the fault report form.
- Prepare for all books (its counts and button); the Details page of a reading sync (engine, GPU use, stage times). Correcting one sentence's timing leaves the interface.
- The chapter matcher of the older engine. Production runs whole-book jobs (`ALIGNMENT_BOOK_JOBS=1`), which have no matching step.
- The rest of Activity › Server on the phone: the board shows the top of the list; Series search, Ebook checks, Hardcover sync, Database backups and Imports follow in the same row and are on the desktop board.
- The series view with the new status lines.
- Appearance, Reading, Account, Users, Library and storage and App detail pages.
- Sign-in and join screens; empty, loading, offline and error states; toasts and confirmations (Restart, Remove, turning Keep off).
- The other theme presets and the compact density. Tablet width.

## Decided by the owner (2026-11-16)

Every question this section used to ask is answered. The full list is `docs/REDESIGN_PLAN.md` section 0.1 in the app repository; this is what a designer needs.

- **Places.** Activity is the fourth place and takes the Downloads slot. It is the administrator's view of the server's work; a save to a device is not an activity but is listed in Now. Someone who is not an administrator sees Now (their own saves) and This device.
- **Names.** "Reading sync" is the only name on screen, also for its queue and its worker. The manual action is "Prepare again". Recording, not Version. The row is "Reading mode" with Pages and Scroll. A queue that is off reads "Paused"; a worker that is off reads "Not in use".
- **Keep on this device** is one switch per book, and a standing choice: it saves what arrives later and never removes anything without a tap. Off asks once with the total size.
- **Library.** A book with only an ebook, only a PDF or nothing yet is a Library entry. Chips: All, Series, In progress, Not started, Finished, On device, Favorites. The Hardcover shelf and list filters move into the one sort-and-view control. Series are a filter chip, not stacked tiles.
- **Discover finds books, not files.** AudioBookBay, Prowlarr and Library Genesis are searched only inside Get.
- **Book page.** A description collapsed to three lines, one Hardcover row, no rating.
- **Reader.** One view in two reading modes; Lyrics and Word are gone, and so is correcting a sentence's timing. Reading mode is the first row of Appearance. At rest the foot keeps a small Pause. Controls stay until the text is tapped again. Speed and the sleep timer live in the foot. Every message appears in the foot. "Text is never covered" means the book's text: tooltips, sheets and dialogs open over rows everywhere else.
- **Faces.** Now playing opens on the face last used for that book on that device. A book without an EPUB has no Read face; a book without a recording has no Listen face.
- **Tooltips.** All 51 are built and pruned later from use.
- **Settings.** No Reading page: Reading mode and Follow the narration are a group in Playback.
- **Desktop and tablet.** Every screen ships both layouts. A page with no desktop board is the phone layout in one centred column beside the rail. Desktop starts at 760 px.
- **Boards still missing** ("Not drawn yet") are drawn shortly before their slice is built and need the owner's OK on the canvas first.

## Facts to respect when refining

- Mobile first, one user, installed as a PWA on a phone; desktop is secondary.
- UI copy: keep text that has a function (labels, status, instructions); no taglines or decorative descriptions. The owner removed those app-wide.
- Skips are 30 seconds for every remote command, including next and previous.
- Progress is kept per recording. Choosing a recording and choosing where it plays from (device copy, server copy, original stream) are separate choices and must stay visibly separate: Recordings and Plays from are different groups on the Audiobook page.
- A reading sync map belongs to one recording and one EPUB, which is why the Reading sync page starts with that pair. Its timings are labelled "estimated".
- Reading sync runs on the worker pool (wsl with a GPU first, lisa with a CPU as the fallback), only in English, and a whole-book job that is paused starts over on Resume. The boards say so where it matters.
- Only an administrator can get files, save to the server, report problems, prepare reading sync, and see the server's queues and workers.
- Saving to a phone needs the app open; only complete files play offline.
- The reader's settings today (`src/appearance.ts`): theme, font, size, line height, margin, width, pages or scroll, and the view (book, segment, word) with segment words and words per minute. The fourth round removes the view and its two settings; everything else stays.
- A book without audio is in the library through a placeholder audio edition, and that stays (status note on ADR 0002). The screens address a book by its work.
- Placeholders in brackets (`[NARRATOR]`, `[AUTHOR]`, `[EXCERPT]`, `[REVISION]`, `[N] minutes`, `[REASON FROM THE WORKER]`, `[USERNAME]`, `[FREE SPACE]`) stand in for real data. Sizes, times, counts and percentages are samples. Covers are coloured blocks, not real art.

## Checked and not checked

Checked on 2026-11-16, in Chromium at each board's own size with the real fonts loaded:

- No board clips or overflows its frame, no element is pushed outside it, and every element is closed with quoted attributes. This includes the first-draft boards, which had not been rendered before. The check was run again after the fifth round on all 40 boards; what it still reports is the three intended cuts listed below.
- In the pages layout the text block of a reader board ends on a whole line on purpose (`data-clip` on that element tells the check so). The two "across pages" boards are the same text, the second one moved up by exactly one page, so the sentence really continues where it broke.
- A tooltip opens and closes on a tap in Chromium, and the three that are drawn open (on Book, Worker and the desktop Server board) sit under their entry with the pointer at the mark.
- Three things are cut on purpose: the long title *There Is No Antimemetics Division* ends in an ellipsis where it has one line (mini player, tiles, list rows); *The Picture of Dorian Gray* does the same on a library tile; and the Library chip row runs off the right edge because it scrolls.
- One fix to a first-draft board: the sample row on the design language board read "Default speed" and wrapped; it now reads "Speed".

Not checked: how the boards look on the canvas itself. They were published without a refusal, but no tool can render the canvas, so the first look is the owner's. The same goes for the accent tweak, the links in Play mode, and whether a tooltip opens on a tap in Play mode there (it is a native `<details>` element, which the canvas format neither names nor forbids).

## Canvas rules that are easy to break

- Each board is a self-contained `.dc.html` with the `support.js` head line kept exactly; styling is inline; `{{accent}}` is the only bound value. Edit the files by hand; they are plain markup.
- Close every element and quote every attribute (`aria-disabled="true"`, never a bare `disabled`). No braces in text. Icons are inline stroke SVG, never emoji.
- Real `<button>`, `<a href>` and `<input>` with a label, also in a static mock-up. A row that is a link must be the `<a>` itself; a row that holds a switch or a button is a `<div>`.
- Phone boards have a fixed 390×844 root. Desktop boards are fluid pages (`"expand": "fill"` in `canvas.json`, no pixel width on the root, rail and content in a wrapping flex row), and their frame height is the page's height at 1280 wide.
- A new board needs its file, an entry in `boards` and a slot in `order` in `canvas.json`. Frames in a row are 80 apart; a row's title note sits 260 above it.
- A tooltip is `<details name="tip">` with the mark as its `<summary>`, a pointer and the bubble. The bubble is placed against the nearest ancestor with `position: relative` (the row, the caption line or the header), so that ancestor needs it, and the card around it must not have `overflow: hidden`. A row with a tooltip is a `<div>`: its name and its right edge are the link or button, because an interactive element cannot sit inside another.
