# Sonder

A self-hosted audiobook player with a built-in ebook reader that follows the narration.

## Catalogue

**Series**:
An ordered group of related works.

**Saved series**:
A series a user has added to their library for ongoing reference, independently of the individual works they have added.

**Work**:
A book as an abstract title, independent of any edition, recording or file.
_Avoid_: Title, book (when the abstract work is meant)

**Audio edition**:
A published audiobook of a work; what a library row points at.
_Avoid_: Audiobook, release (for the edition itself)

**Recording**:
One concrete release of an audio edition (a set of tracks from one source). Progress belongs to a recording.
_Avoid_: Version, file

**Ebook edition**:
An EPUB or PDF of a work.
_Avoid_: Ebook file

**Delivery source**:
Where a recording's bytes come from on this play: device copy, server copy, or the original stream.
_Avoid_: Source (alone), copy

## Reading along

**Page mode**:
The reader showing the ebook as turnable pages.
_Avoid_: Book view, paginated mode

**Lyrics mode**:
The reader showing one sentence per line, scrolling with the narration.
_Avoid_: Karaoke, line mode

**Alignment map**:
The sentence-to-time mapping between one recording and one ebook edition. Always generated and always estimated; nobody reviews or corrects it.
_Avoid_: Sync map, timings, reviewed map

**Unsynced passage**:
Part of an ebook edition that has no place in the alignment map, because the narration could not be matched or the language is not supported.
_Avoid_: Gap, missing timings

**Rebuild**:
Automatically generating a fresh alignment map when the existing one was made by an older engine, replacing the old map entirely when it finishes.
_Avoid_: Re-sync, repair, migrate

**Narrated sentence**:
The sentence the narration is currently speaking, located through the alignment map.
_Avoid_: Current passage, highlight

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

## Accounts and access

**Account request**:
A prospective user's application for access to a Sonder space, awaiting administrator approval.
_Avoid_: Invite request, registration request

**Invite link**:
A single-use, time-limited cryptographic URL sent by email allowing an approved applicant to set their password and activate their account.
_Avoid_: Invite token, access link, activation code
