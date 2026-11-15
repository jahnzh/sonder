# Work media state is derived when read

A work's **media state** for a user (`missing`, `queued`, `failed`, `available`) is computed when it is read, from the work's tracks and the user's latest acquisition for it. It is no longer stored and refreshed after every change. The table `work_media_states` keeps one row per user and work as the marker that the work is **tracked** for that user, together with the **hold reason** (`unreleased`, `empty_search`), which nothing else records.

The acquisition status vocabulary (`checking`, `preparing`, `downloading`, `paused`, `ready`, `error`) lives in one module together with the sets "active" and "finished" and the one function that writes an acquisition's status. Every writer calls that function, including the pause, resume and retry routes.

Copies to the server keep a vocabulary of their own (`queued`, `downloading`, `paused`, `ready`, `error`). A copy duplicates a recording that is already in the library, an acquisition brings a release in, and the two finish differently. The one place that shows copies in the download list translates their words with a named function.

## Considered options

- **Keep the stored state and route every status write through one function that refreshes it.** This removes the scattered calls, but any future writer that bypasses the function leaves a wrong state with no error. About 21 refresh calls in 7 files existed to keep the stored copy right, and one writer already skipped it.
- **Drop the table.** The hold reason would have nowhere to live.

## Consequences

- The columns `state` and `acquisition_id` stay in `work_media_states` because the schema only grows (see CLAUDE.md, Database). They are no longer read. New rows write `state` as `missing` to satisfy the column's constraint.
- Reading the state for a whole library or series is done for all works in one pass (a fixed number of queries), not one work at a time.
- A work has a media state for a user only while the user has an acquisition for it or a `work_media_states` row marks it as tracked, as before; otherwise the read returns null (for example a library book that was uploaded or imported). Library membership or a saved series alone does not give a work a media state. The row is written by the hold functions and by one insert-if-absent function for the series flows and "Add series", which tracked a work without an acquisition or a hold; that function never changes a row. The rule is decided in the read function and pinned by tests written against the earlier behaviour first.
- Tests: the transitions of an acquisition without HTTP routes, and for every status write that the media state read afterwards is the expected one.
- Issue: #395.
