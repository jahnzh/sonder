# Sonder

A self-hosted audiobook player with a built-in ebook reader that follows the narration.

## Catalogue

**Series**:
An ordered group of related works.

**Saved series**:
A series a user has added to their library for ongoing reference, independently of the individual works they have added. Its list follows AudiobookDB (#721): a work AudiobookDB adds later is marked new. Removing it keeps its works in the library unless the administrator also removes the works it added.
_Avoid_: Followed series, series selection

**Related work**:
A work the catalogue lists in a series without a number, such as a companion or a collection. It is shown after the numbered works and does not count towards how many of the series are finished.
_Avoid_: Unnumbered work, extra

**New in a series**:
A work AudiobookDB added to a saved series after the user last reviewed it. It stays marked until the user dismisses the marks or adds a work from the series.
_Avoid_: Unseen work

**No audiobook yet**:
A book of a series that AudiobookDB does not list because it has no audio release; Open Library lists it. Its ebook can be fetched, and its audiobook is searched for once AudiobookDB lists it.

**Added with a series**:
A work that came into a user's library when they saved a series or added a work from it, as opposed to one added on its own (or, before #721, from Hardcover's shelves). Only these are offered for removal together with the series.
_Avoid_: Introduced

**Work**:
A book as an abstract title, independent of any edition, recording or file. A user's library is made of works, whether a work has an audio edition, an ebook edition, both or neither yet.
_Avoid_: Title, book (when the abstract work is meant)

**Audio edition**:
A published audiobook of a work.
_Avoid_: Audiobook, release (for the edition itself)

**Placeholder**:
An audio edition with no tracks, through which a work without audio is in a user's library. Each work has at most one; it never leaves the server, and real audio arriving takes its place in every library that holds it.
_Avoid_: Fake edition, stub, shelf book

**Recording**:
One concrete release of an audio edition (a set of tracks from one source). Progress belongs to a recording.
_Avoid_: Version, file

**Chosen recording**:
The recording of a work that a user listens to when the work has more than one. The choice is the user's and is the same on all their devices. Until they choose, it is the recording with their newest saved place, otherwise the one added first.
_Avoid_: Default recording, selected release, active version

**Ebook edition**:
An EPUB or PDF of a work.
_Avoid_: Ebook file

**Delivery source**:
Where a recording's bytes come from on this play: device copy, server copy, or the original stream.
_Avoid_: Source (alone), copy

**Get**:
The administrator's action of bringing a missing file to a work: a recording from AudioBookBay, Prowlarr, a magnet link or audio files from the device, or an ebook edition from Library Genesis or a file from the device. It always happens in the Get sheet of that work, and the file joins that work.
_Avoid_: Find another release, Find ebook, acquire (on screen), download (for the action)

**Preview**:
A stretch of a release TorBox already holds ("Plays now"), heard in the Get sheet before it is got: up to two minutes of one of its files, in an audio element of its own, never the player's. It makes no recording and writes no listening position. The release stays on the TorBox account afterwards.
_Avoid_: Sample (a file name the preview passes over), trial

**Release**:
A listing a source offers before Sonder has it: a torrent of a recording on AudioBookBay or an indexer behind Prowlarr, or a file of an edition on Library Genesis. Getting one makes it a recording or an ebook edition of the work. A release TorBox already holds plays at once ("Plays now"). On screen a release is called a recording or an edition.
_Avoid_: Result, torrent (alone), version

**Device save**:
Copying a work's files onto one device, done by that device's browser while Sonder is open there. The server knows what the device should keep but does not see the save, so it is not an activity.
_Avoid_: Download (alone), offline download

**Keep on this device**:
A user's standing choice, for one work on one device, that the device holds the chosen recording, the chosen ebook edition when it is an EPUB, and their alignment map. It can be made before any of them exists. It is recorded on the server for each device, so a device whose browser cleared its storage learns it again. Device saves follow from it whenever one of the three is missing there, and nothing leaves the device unless the user asks.
_Avoid_: Save offline, offline copy, pin

**Earlier copy**:
The files of a recording that a device kept while it was the chosen recording, after the user chose another. They stay on the device, listed with their size, until the user removes them or turns Keep on this device off.
_Avoid_: Old download, previous version

**In progress**:
A work the user has started and not finished: it has a saved place in a recording or an ebook edition that is not the end.
_Avoid_: Listening (for the state of a work), reading

**Finished**:
A work the user has completed: one of its recordings or ebook editions reached the end, or the user marked it so.
_Avoid_: Done, read, completed

**Media state**:
Whether a user can listen to a work: missing, queued, failed or available. It is worked out from the work's tracks and the user's latest acquisition when it is read.
_Avoid_: Download status, availability

**Hold reason**:
Why Sonder is not trying to acquire a missing work for now: it is unreleased, or the last search found nothing. It stays until an acquisition for the work is ready or the user retries.
_Avoid_: Block, skip reason

**Catalogue match**:
The link between a work and its book in the catalogue: AudiobookDB for an audiobook, Open Library for a book without one (#721). A recording may also link to an AudiobookDB release (narrator, length, ASIN). It is the same for every user of the server, so only the administrator makes or changes it, on the book's match page. It replaces the Hardcover match, which went with Hardcover's sync (#721 part d).
_Avoid_: Hardcover match, linked book

**Want to read**:
Sonder's own shelf of works a user means to read or listen to, per user, in their library. Reading and Finished are not shelves kept beside it: they come from the user's own progress. At the switch from Hardcover each user's Hardcover Want to read shelf was copied into it once.
_Avoid_: Hardcover shelf, wishlist

**Catalogue book**:
A book in AudiobookDB or Open Library, as Discover finds it. One that no work on the server is linked to opens as a book not in the library under the work id it will get (`work-abdb-<id>`, `work-ol-<id>`; ADR 0022's rule), and becomes a work when someone adds it or gets a file for it. An address `work-hc-<id>` from an older build, when Discover searched Hardcover, opens the work stored as matched to that Hardcover book; Hardcover is never asked.
_Avoid_: Hardcover book (since #721), catalogue entry, external book

## Screens

**Place**:
One of the four top-level areas of the app: Library, Discover, Activity and Settings.
_Avoid_: Tab, section

**Page**:
A full screen with its own address, opened from a place or from another page, such as a book, a series or a worker.
_Avoid_: Screen, view, dialog

**Sheet**:
A full-screen task opened over a page, such as Get. Going back closes it and returns to the page.
_Avoid_: Modal, dialog, popup (a pop-up is a setting pop-up, which is not a sheet)

**Picker**:
A short list of choices that opens over a page from its bottom edge, such as the Library's Sort and view or its Shelf. It has no address: a choice applies at once, Done or a tap outside closes it, and Back leaves the page under it, as for a tooltip.
_Avoid_: Dropdown, menu, popover, select

**Setting pop-up**:
The small box that Speed or the sleep timer in the reader's foot opens above its button, holding that setting's controls, each change applied at once. It is the one thing drawn over the text band, at most 120 px into it, and only on the reader's tap on its button; nothing is dimmed and the text is not laid out again, and a tap outside it, Escape, its button again or the controls hiding closes it (ADR 0019, amended 2026-11-24). It has no address and is not a sheet, a picker or a dialog.
_Avoid_: Popover, menu, dialog, overlay

**Old name**:
An address from before the redesign, such as `#downloads` or `#reader/<ebook id>`, that keeps working for good by opening the page that took its place and replacing itself in the history.
_Avoid_: Legacy route, alias, deprecated address

**Token**:
A named value of the design language that every screen takes its spacing, corners, heights, text styles and colours from. A stylesheet sets a corner or spacing only through a token; a value the boards draw that no token gives is marked as an exception where it is written (ADR 0023).
_Avoid_: Magic number, design variable, theme value

**Offline line**:
The one line the shell shows above the player while the device has no connection, on every place and page that does not say so itself.
_Avoid_: Offline banner, offline toast

## Reading along

**Face**:
One of the two sides of the screen for the work in use: Listen, the player, or Read, the reader. A device reopens a work on the face last used there. A work without a recording has no Listen face, and a work without an EPUB has no Read face.
_Avoid_: View, tab, mode (which is pages or scroll)

**Head**:
The band at the top of the reader's page, 44 high plus the phone's safe area. At rest it names the book and chapter; a tap on the text shows the reader's controls in it. It keeps its height either way, so the text never moves.
_Avoid_: Top bar, toolbar, header

**Foot**:
The band at the bottom of the reader's page, 72 high plus the phone's safe area. At rest it holds the progress line, the time left and Pause; with the controls shown, the timeline and the transport. Every message while reading is in it: a notice with Undo takes its first row (the timeline, or the status line of a book without a recording) on a phone with the controls shown, the others its lower row. Speed and the sleep timer open a setting pop-up above their button, the one thing drawn over the text band (ADR 0019).
_Avoid_: Player bar, bottom bar, footer, toast

**Text band**:
The part of the reader's page between the head and the foot, or a docked panel, where the book's text is laid out. It changes size only with the window or when Appearance docks or closes, never on a tap.
_Avoid_: Viewport, page area, reading area

**Pages mode**:
The reader showing the ebook as turnable pages.
_Avoid_: Page mode, book view, paginated mode

**Scroll mode**:
The reader showing the ebook as one continuous column that moves.
_Avoid_: Scrolled mode, continuous mode

**Alignment map**:
The sentence-to-time mapping between one recording and one ebook edition. Always generated and always estimated; nobody reviews or corrects it.
_Avoid_: Sync map, timings, reviewed map

**Reading sync**:
What a user sees of an alignment map: the ebook following the narration, and whether that is ready, being prepared or stopped. It is the only name for it on screen.
_Avoid_: Alignment (on screen), read-along

**Unsynced passage**:
Part of an ebook edition that has no place in the alignment map, because the narration could not be matched or the language is not supported.
_Avoid_: Gap, missing timings

**Rebuild**:
Automatically generating a fresh alignment map when the existing one was made by an older engine. The existing map stays the map in use until the new one is ready; the new one replaces it entirely, unless it maps none of the text, clearly less of it, or ends with the language not supported, and then it is not used.
_Avoid_: Re-sync, repair, migrate

**Prepare again**:
Generating a fresh alignment map because the user asked for it. As with a rebuild, the existing map stays the map in use until the new one is ready, and a new one that is clearly worse is not used.
_Avoid_: Rebuild (for the manual action), re-sync

**Spare edition**:
An EPUB of a work that nobody reads: not the work's shared default (or, without one, its first EPUB), and no account has a place in it. It was fetched to find the edition that matches the narration; its check against the narration is the probe, and nothing syncs it whole by itself (ADR 0024).
_Avoid_: Other ebook, extra copy, set member (when the unread edition is meant)

**Prepared text**:
An EPUB's text as the server makes it ready to read: sanitised HTML cut into parts, every sentence wrapped and tagged with the id it already has, and a manifest that lists the parts with their character counts (ADR 0025). The reader shows the prepared text instead of laying out the EPUB file itself. The sentences and their ids are the ones the alignment map, places and bookmarks use; preparing changes how they are drawn, never what they are.
_Avoid_: Rendered EPUB, converted book, chunk (a piece of the prepared text is a part)

**Map in use**:
The alignment map the reader follows for one recording and one ebook edition. While a rebuild or Prepare again runs, it is the earlier map. A map made for files that have changed since is never in use.
_Avoid_: Published map, kept map, old map

**Narrated sentence**:
The sentence the narration is speaking, or the last one it spoke until the next one begins, located through the alignment map.
_Avoid_: Current passage, highlight

**Narration highlight**:
The mark on the narrated sentence in the reader. It stays through a silence or narration the ebook does not have, and moves only when the next sentence begins.
_Avoid_: Mark, current highlight

**Following**:
The state where the reader keeps the narrated sentence in view on its own.
_Avoid_: Synced, live, linked

**Paged away**:
The state where the reader shows something other than the narrated sentence because the reader navigated.
_Avoid_: Off narration, unlinked

**Text position rail**:
The thin column in the text band's right margin of the new reading view, always shown: the whole book cut at its chapters, or the chapter of the place in view cut at its sentences (Reading position shows). A place on it is a sentence's place among the book's sentences; dragging it moves the text as a move by hand does and never touches the audio.
_Avoid_: Scrollbar, position bar, scrubber (the foot's slider)

**Thumb**:
The mark on the text position rail at the place of the first sentence in view, in the accent colour while following; held, it is the place the finger has taken the text to.
_Avoid_: Handle, knob, cursor

**Narration mark**:
The mark on the text position rail at the narrated sentence's place, shown while paged away. It is not the narration highlight, which marks the narrated sentence in the text.
_Avoid_: Narration highlight, audio marker

**Back to narration**:
The action that returns a paged-away reader to the narrated sentence and resumes following. With no narrated sentence at the position, the administrator's Back to narration locates the passage from the audio instead (#592).
_Avoid_: Relink, resync, Read from audio

**Bookmark**:
A saved sentence in an ebook edition: the narrated sentence while following, otherwise the first sentence on screen.
_Avoid_: Page bookmark, marker

**Listen from here**:
The action that moves the narration to a chosen sentence in the ebook.
_Avoid_: Jump audio, seek to text

## Book knowledge

**Book knowledge**:
The characters, terms and relationships described by a work, available through chat, a character index and glossary, and a relationship graph.
_Avoid_: Book chat (when all three experiences are meant)

**Knowledge cutoff**:
The position a user explicitly chooses as the end of the text available to spoiler-free book knowledge. It stays fixed while Book knowledge is open until explicitly changed, and can move backward independently of the furthest position reached.
_Avoid_: Progress (when the chosen limit is meant), furthest read

**Knowledge fact**:
A statement about a knowledge entity, such as a name, description, relationship or identity link, supported by passages in the selected ebook edition and available only once the text needed to establish it has been reached.
_Avoid_: Full-book biography (when an individual statement is meant)

**Knowledge entity**:
A character, place, group, important object or unfamiliar term that book knowledge describes, and that knowledge facts and mentions refer to.
_Avoid_: Node (a drawing of an entity in the graph), character (when places, groups, objects or terms are included)

**Identity link**:
A knowledge fact stating that two knowledge entities are the same one, either because the story reveals it or because extraction recorded one entity twice.
_Avoid_: Merge, dedupe (both suggest rewriting earlier views), identity assertion

**Spoiler-free mode**:
Book knowledge limited to information available through the user's chosen knowledge cutoff.
_Avoid_: Progress mode, up-to-position mode

**Complete mode**:
Book knowledge with access to the whole work's selected text, regardless of the user's knowledge cutoff.
_Avoid_: Whole-book mode

**Term highlight**:
An optional mark on a relevant name or term in the reader that links to its entry in Book knowledge, subject to the selected mode and knowledge cutoff.
_Avoid_: Narration highlight (which marks the narrated sentence)

## Background work

**Activity**:
One unit of background work the administrator can see and act on, such as a copy to the server, an alignment job, a database backup, or a worker host's current job.
_Avoid_: Job, task, download (when the general unit is meant)

**Background process**:
A recurring loop or standing service that produces activities, such as the queue refresh, the alignment processor or an alignment worker.
_Avoid_: Ticker, daemon, service (when the owner-facing unit is meant)

**Pause**:
Stopping a background process from starting new work while the activities already running finish.
_Avoid_: Stop, disable

**Stuck**:
A running activity whose progress and last update have not changed for longer than is normal for its kind.
_Avoid_: Hung, frozen

**Needs attention**:
What the user has to look at: for the administrator, an activity that failed in the last seven days, is stuck or is blocked, and a background process that is down; for anyone, a device save on the device in hand whose last attempt failed. It lights the attention dot on Activity, and Activity's Now lists exactly these under that name. A paused process and a worker that is not in use need no attention.
_Avoid_: Error, alert, problem (for the state)

**Activity source**:
A feature's own description of its background process and its current activities, which Activity's Server part collects.
_Avoid_: Adapter, provider

**Worker lease**:
The right to use one alignment worker for one piece of work, with the recording's audio staged on it, until it is released.
_Avoid_: Slot, dispatch (when the caller's view is meant)

## Accounts and access

**Account request**:
A prospective user's application for access to a Sonder space, awaiting administrator approval.
_Avoid_: Invite request, registration request

**Invite link**:
A single-use, time-limited cryptographic URL sent by email allowing an approved applicant to set their password and activate their account.
_Avoid_: Invite token, access link, activation code
