# Sonder

A self-hosted audiobook player with a built-in ebook reader that follows the narration.

## Catalogue

**Series**:
An ordered group of related works.

**Saved series**:
A series a user has added to their library for ongoing reference, independently of the individual works they have added.

**Work**:
A book as an abstract title, independent of any edition, recording or file. A user's library is made of works, whether a work has an audio edition, an ebook edition, both or neither yet.
_Avoid_: Title, book (when the abstract work is meant)

**Audio edition**:
A published audiobook of a work.
_Avoid_: Audiobook, release (for the edition itself)

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

**Device save**:
Copying a work's files onto one device, done by that device's browser. The server does not see it, so it is not an activity.
_Avoid_: Download (alone), offline download

**Keep on this device**:
A user's standing choice, for one work on one device, that the device holds the chosen recording, the chosen ebook edition when it is an EPUB, and their alignment map. It can be made before any of them exists. Device saves follow from it whenever one of the three is missing there, and nothing leaves the device unless the user asks.
_Avoid_: Save offline, offline copy, pin

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

**Hardcover match**:
The link between a work and its book on Hardcover, through which a user's shelf, lists and progress sync. It is the same for every user of the server, so only the administrator makes or changes it.
_Avoid_: Hardcover link, linked book

**Hardcover edition**:
The audio edition on Hardcover that a user's place in one recording is sent to. It is automatic (the edition of the user's current read there, or the one with the same narrator) until the user chooses one.
_Avoid_: Recording edition, Hardcover audio edition

## Screens

**Place**:
One of the four top-level areas of the app: Library, Discover, Activity and Settings.
_Avoid_: Tab, section

**Page**:
A full screen with its own address, opened from a place or from another page, such as a book, a series or a worker.
_Avoid_: Screen, view, dialog

**Sheet**:
A full-screen task opened over a page, such as Get. Going back closes it and returns to the page.
_Avoid_: Modal, dialog, popup

## Reading along

**Face**:
One of the two sides of the screen for the work in use: Listen, the player, or Read, the reader. A device reopens a work on the face last used there. A work without a recording has no Listen face, and a work without an EPUB has no Read face.
_Avoid_: View, tab, mode (which is pages or scroll)

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
Automatically generating a fresh alignment map when the existing one was made by an older engine, replacing the old map entirely when it finishes.
_Avoid_: Re-sync, repair, migrate

**Prepare again**:
Generating a fresh alignment map because the user asked for it. As with a rebuild, the existing map stays in use until the new one is ready.
_Avoid_: Rebuild (for the manual action), re-sync

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

**Back to narration**:
The action that returns a paged-away reader to the narrated sentence and resumes following.
_Avoid_: Relink, resync

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
One unit of background work the administrator can see and act on, such as a copy to the server, an alignment job, a queue of changes waiting for Hardcover, or a worker host's current job.
_Avoid_: Job, task, download (when the general unit is meant)

**Background process**:
A recurring loop or standing service that produces activities, such as the queue refresh, the Hardcover sync, the alignment processor or an alignment worker.
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
A feature's own description of its background process and its current activities, which the Activity page collects.
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
