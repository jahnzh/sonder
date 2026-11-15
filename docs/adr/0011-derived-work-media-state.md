# Work media state is derived when read

A work's **media state** for a user (`missing`, `queued`, `failed`, `available`) is computed when it is read, from the work's tracks and the user's latest acquisition for it. It is no longer stored and refreshed after every change. The table `work_media_states` keeps one row per user and work as the marker that the work is **tracked** for that user, together with the **hold reason** (`unreleased`, `empty_search`), which nothing else records.

The acquisition status vocabulary (`checking`, `preparing`, `downloading`, `paused`, `ready`, `error`) lives in one module together with the sets "active" and "finished" and the one function that writes an acquisition's status. Every writer calls that function, including the pause, resume and retry routes.

Copies to the server keep a vocabulary of their own (`queued`, `downloading`, `paused`, `ready`, `error`). A copy duplicates a recording that is already in the library, an acquisition brings a release in, and the two finish differently. The one place that shows copies in the download list translates their words with a named function.

## Considered options

- **Keep the stored state and route every status write through one function that refreshes it.** This removes the scattered calls, but any future writer that bypasses the function leaves a wrong state with no error. About 21 refresh calls in 7 files existed to keep the stored copy right, and one writer already skipped it.
- **Drop the table.** The hold reason would have nowhere to live.

## Consequences

- The columns `state` and `acquisition_id` stay in `work_media_states` because the schema only grows (see CLAUDE.md, Database). They are no longer read. New rows write `state` as `missing` to satisfy the column's constraint.
- Before rolling back to an image from before this decision, run `node scripts/materialise-media-states.mjs` (docs/LOCAL_CHECKS.md, Production deployment), because those images read the stored `state` and `acquisition_id` columns, which are no longer kept current. It writes the derived state (the hold reason as the read returns it) into `state`, `hold_reason`, `acquisition_id` and `updated_at` for every user and work with a media state, creating the rows the earlier refresh would have created, in one transaction; a second run changes nothing. It opens the database file without the server's `db.ts`, so it works while the server runs and when the server cannot start.
- Reads never write. A hold reason set by `setWorkMediaHold` or `markWorkEmptySearch` is stored and returned exactly as stored, also while the work is playable (as the earlier read returned the stored row). Two writes clear it, and nothing else does: an acquisition for the work reaching `ready` (in `setAcquisitionStatus`, for every user of that acquisition, also users who never open the work while its audio is there), and the user's retry (`clearWorkMediaHold`). The series view offers a retry for an empty search only while the work is not available, so a hold stored on an available work shows nothing.
- Accepted difference from the image before this decision: that image also cleared a hold whenever one of its scattered refresh calls ran while the work was playable, for example after audio arrived by upload or import rather than by an acquisition. Such a hold now stays stored; it has no visible effect while the work is available and shows again only if that audio is later removed, until the user retries. The other way round, a `ready` acquisition now clears the hold even if its import left the work without playable audio, where the earlier refresh kept it.
- The read uses indexes on `audio_editions(work_id)`, `recordings(edition_id)` and `tracks(recording_id)`, so its cost follows the works read, not the size of the audio tables.
- Reading the state for a whole library or series is done for all works in one pass (a fixed number of queries), not one work at a time.
- A work has a media state for a user only while the user has an acquisition for it or a `work_media_states` row marks it as tracked, as before; otherwise the read returns null (for example a library book that was uploaded or imported). Library membership or a saved series alone does not give a work a media state. The row is written by the hold functions and by one insert-if-absent function for the series flows and "Add series", which tracked a work without an acquisition or a hold; that function never changes a row. The rule is decided in the read function and pinned by tests written against the earlier behaviour first.
- Tests: the transitions of an acquisition without HTTP routes, and for every status write that the media state read afterwards is the expected one.
- Issue: #395.
