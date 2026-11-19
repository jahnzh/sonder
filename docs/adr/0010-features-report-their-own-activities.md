# Features report their own activities

**Status (2026-11-19).** The Activity page is now the Activity place (#516): the sources described here feed its Server part (#519) and the attention dot, and Now groups the same items by book (#522). The decision stands.

Each feature that runs work in the background describes it to the Activity page itself. A feature module exports one **activity source**: the identity of its **background process** (id, label, whether it can be paused and what pausing does), the time after which a running **activity** counts as **stuck**, a function that returns the feature's current activities, and the actions an activity supports (retry, discard). The Activity module keeps a plain list of the sources and does only what is common to all of them: it asks each source for its activities when the page is requested, marks stuck and blocked ones, applies the pause switches, sorts, counts and dispatches an action to the source that owns the activity. It contains no SQL against a feature's tables and no feature status words.

A source reads its rows from the database when asked. Nothing is pushed to Activity and Activity stores nothing about a feature, so there is no second copy of a job's state that can go stale.

Each source maps its own status vocabulary to the Activity states (`queued`, `running`, `paused`, `done`, `failed`) with a table over the feature's status type, so the typechecker refuses a status without a mapping. A status read from the database that is not in the vocabulary is shown as failed with the text "Unknown status", never as running.

The list of sources is written out in one file. Sources do not register themselves on import, because import order would then decide what the page shows.

The same description owns the loop. A background process declares its interval and its tick function, and one runner starts every process, skips a tick while the process is paused or disabled by its environment flag, and stops them all when the server closes. The timers in `server/app.ts` and `server/alignment.ts` move there.

## Considered options

- **Activity keeps reading every feature's tables** (the state on 2026-11-14). A new status in a feature silently falls through to "running": a failed series acquisition was shown as running, then stuck (#397).
- **Features push events to Activity.** This needs a store in Activity and a replay after a restart, for state the database already holds.
- **Self-registration on import.** Shorter, but a source that is never imported disappears without an error.

## Consequences

- Built in two steps: the sources with their status tables first (this also fixes #397), then the runner for the loops. The page, its API and the pause settings keep their shape, so open older client builds keep working.
- Every source has a test that walks its whole status vocabulary and asserts the Activity state of each value.
- Worker hosts (#357), scheduled backups (#361) and imports (#362) arrive as further sources, not as new branches in the Activity module.
- A probe that a source needs (torrent client, alignment pool) stays behind that source, with the existing time limit.
- A source also fills what the page needs to group by book and to word the status line (#514): the work, its audio edition and cover of the item (read with its rows, by the cover rule of the library by work) and the facts of its line, one shape per kind, from rows it already reads. Whether an item needs attention is still decided in the Activity module alone.
- Issue: #392.
