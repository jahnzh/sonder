# Architecture review: deepening opportunities

Date: 2026-11-02. Method: the `codebase-design` vocabulary (module, interface, seam, depth, leverage, locality) and its deletion test, applied to `server/` and `src/` by reading code through CodeGraph and targeted greps. Nothing was changed in code. Each candidate is a proposal for a decision, not a commitment.

Scope note: there is no `improve-codebase-architecture` skill installed, so this review used `codebase-design` directly. `GLOSSARY.md` covers the catalogue and reading-along terms only, and `docs/adr/` does not exist yet. Neither has been edited; where a candidate would need a new term or ADR, that is listed under it.

Evidence labels: **Verified** means seen in the source during this review. **Hypothesis** means inferred from file size or names and not yet read.

## Candidates, ranked by leverage

### 1. Admin authorization is a regex list, not part of each route's interface

**Verified.** `server/app.ts:278` is one `preHandler` containing about ten alternated path and method regexes that decide which routes call `requireAdmin`. Other routes call `requireAdmin` inline: `app.ts:473`, `alignment.ts:1071` and `1089`, `hardcover-routes.ts:53`, and all of `users.ts`. A route registered in `reader.ts` or `media-library.ts` is admin-only only if someone remembers to edit a regex in a different file (`/api/reader/:id/link` and the `/api/recordings/:id/faults|server-copy` routes already are).

- **Problem:** the route's access rule lives away from the route. A new admin route that misses the regex is open to every signed-in user, and nothing fails.
- **Deletion test:** deleting the regex block makes the rule reappear at each route. That is where it belongs, so the block is a shallow pass-through of knowledge.
- **Deepened shape:** one small interface, an `access` option on route registration (`"user"` or `"admin"`, default `"user"`). The `preHandler` reads `req.routeOptions.config.access`. One test enumerates `app.printRoutes()`/registered routes and asserts the admin set, so adding a route forces a decision.
- **Dependencies:** in-process (Fastify only). No adapter needed.
- **Tests:** a single route-policy test through `createApp()` replaces scattered per-route 403 checks. Keep one behavioural 403 test per distinct rule (the hardcover and settings partial rules at `app.ts:473` and `hardcover-routes.ts:53` are conditional and stay inline).
- **Risk:** low. The change is mechanical, but the current regex set must be transcribed exactly. Generate the before and after route lists and diff them.

### 2. User deletion hard-codes every feature's per-user tables

**Verified.** `server/users.ts:73` deletes from a literal list of 17 tables (`sessions`, `user_acquisitions`, … `user_hardcover_recording_editions`) and then runs `deletionHooks`. Only Hardcover uses `onUserDeleted` (`hardcover.ts:251`). The list is complete today, but `users.ts` must know the schema of every feature, so adding a per-user table in another file requires remembering this line. Forgetting it leaves another user's data orphaned. User IDs are also protected by a high-water mark (`setUserIdHighWater`), which suggests ID reuse was a real concern, and orphaned rows would be exposed to it.

- **Deepened shape:** `users.ts` keeps a registry, `ownsUserRows(table)`, called next to each `CREATE TABLE` (or schema definition) that has a `user_id`. Deletion iterates the registry. Alternatively, derive the set from `PRAGMA table_info` (every table with a `user_id` column except `users`), plus a test that fails when a `user_id` table is not covered.
- **Dependencies:** local-substitutable (SQLite, already used in tests with a temp DB).
- **Tests:** one test creates a user, writes a row in each registered table, deletes the user and asserts zero rows remain. This replaces trust in the list.
- **Risk:** low. Additive and testable. Do not change deletion order inside the transaction.

### 3. Progress write rules live inside an HTTP handler

**Verified.** `POST /api/progress` (`server/app.ts:376-454`) validates input, checks that the track belongs to the recording, applies last-writer-wins by `updatedAt`, writes `user_progress`, lets only the admin set track duration, flips library status `unread` to `listening`, and enqueues Hardcover status and progress writes. `CLAUDE.md` calls these the sync rules (never overwrite a newer position, per-recording progress). They can only be exercised through `createApp()` and HTTP.

- **Deepened shape:** `saveProgress(userId, role, input): { progress, conflict }` in its own module, with the route reduced to parse, call, return. The interface is the invariant set: per-recording keying, timestamp conflict, admin-only duration, status transition, Hardcover enqueue.
- **Seam:** the Hardcover enqueue is a dependency. Two adapters already exist in practice (real queue, and tests that inspect the outbox), so an injected `onProgressSaved` hook is justified. Keep it internal if the tests can use the real SQLite outbox.
- **Locality gain:** the reading-progress path in `server/reader.ts` and `hardcover.ts` (`queueHardcoverReadingProgress`) has the same shape. Doing this first gives the reading side a pattern to copy. **Hypothesis:** that path duplicates the conflict logic. It was not read in this review.
- **Risk:** medium. `tests/api.test.ts` and the e2e tests lean on current behaviour, and older clients still send earlier request shapes (see CLAUDE.md), so the route's tolerance must not change.

### 4. `server/hardcover.ts` (1,988 lines) mixes five concerns behind one file

**Verified from the symbol list, bodies mostly unread.** The file contains: the GraphQL transport with throttling, key lookup, generation check and 429 handling (`graphql`, `runtime`, `lastRequest`, `server/hardcover.ts:293`); account state; the listening and reading outbox queues (`queueHardcover*`, `flushProgress`, `flushReaderProgress`); sync and import (`runSync`, `importCatalogBook`, `metadataLink`); and recording-to-edition claiming (`claimHardcoverAudio`, `setHardcoverRecordingEdition`). It exports about 30 functions.

- **Deletion test:** deleting `hardcover.ts` would spread the transport, queue and mapping logic across `hardcover-routes.ts`, `app.ts`, `alignment.ts` and `reader.ts`, so the module earns its place. The problem is that the file is wide, not shallow, and the transport is the one external seam.
- **Seam worth making real:** the GraphQL transport. It is true-external (Hardcover). Production uses `fetch`; browser tests already install a fixture (`tests/hardcover-browser-fixture.ts`), so there are two adapters today. An explicit `HardcoverTransport` port (`request(userId, query, vars)`) would let the throttle, rate-limit and generation-check logic be tested without patching globals. **Hypothesis:** the fixture currently patches at a different level. Confirm before designing the port.
- **Suggested split by locality, not by size:** `hardcover/transport` (rate limit, key, errors), `hardcover/outbox` (durable queues, coalescing, retry), `hardcover/sync` (pull, import, link). Keep the existing exports re-exported from `hardcover.ts` so importers do not change in one step.
- **Risk:** medium to high. The queues carry user data and the sync rules are subtle ("a newer local position must never be overwritten by an older remote response"). Do this after candidate 3, with `tests/hardcover*.test.ts` as the guard. Do not rewrite the queue logic during the move.

### 5. `createApp()` is a 1,240-line composition root that also holds feature logic

**Verified.** `server/app.ts` registers CORS-like origin checks, the legacy-client JSON parser quirk (URL regexes for two routes, `app.ts:177-192`), auth routes, library, progress, settings, acquisitions, discovery, ebooks, media location, and the background tickers (`app.ts:892-904`). Other areas already follow the better pattern (`registerMediaLibrary`, `registerAlignment`, `registerUsers`, hardcover routes).

- **Deepened shape:** finish the pattern. `registerAuth`, `registerLibrary` (books, library, progress, settings) and `registerDiscovery` (abb, prowlarr, ebooks, acquisitions), plus a `startBackgroundWork(app)` that owns the intervals and their shutdown. `createApp()` becomes plugin registration plus request-wide hooks.
- **Why it is lower than 1 to 4:** it is mostly code motion with little new leverage until candidates 1 and 3 land (they remove the biggest pieces of cross-cutting logic from this file).
- **Specific smell to fix inside it:** the legacy-client body-parser quirk names two routes by regex. Move it beside those routes' registrations so the tolerance requirement stays with the route that needs it.

### 6. `src/App.tsx` (2,938 lines) holds several screens and their data loading

**Verified from sizes and function list.** `LibraryApp` alone runs from line 169 to about 1190, followed by `BookCard`, `BookDetail`, `Discover` (~370 lines), `SettingsPage` (~300 lines) and `ImportDialog` in the same file. About 77 `useState/useEffect/useCallback` call sites. Downloads refresh, library refresh, hash routing and notices are all in `LibraryApp`.

- **Deepened shape:** a `useLibrary()` module owning library fetch, downloads refresh and visibility/hash refresh triggers, so screens consume data and do not re-derive it. Move `Discover`, `SettingsPage` and `BookDetail` to their own files with no behaviour change.
- **Related, Hypothesis:** eight direct `fetch(` calls exist outside `src/lib.ts` `api()` (`reading.ts` ×3, `media-download.ts`, `device-fallback.ts`, `Reader.tsx` and two `build.json` checks). Several are intentionally different (blobs, streaming, cache control). Only the three in `reading.ts` look like candidates to route through `api()`, which would give them its 401 handling and `x-sonder-user-id` header. Verify `api()`'s header behaviour before changing it.
- **Risk:** medium, mainly for UI regressions. CLAUDE.md requires real-UI verification, not fixtures, so budget for that.

### 7. Schema is defined twice (`db.ts` DDL and `schema.ts` Drizzle), and `users.ts` bypasses it

**Verified.** CLAUDE.md documents the double definition as a deliberate constraint ("update both files, stay additive"). In addition, `users.ts` (19 prepared statements) and parts of `db.ts` use raw SQL while the rest of the server uses Drizzle (`hardcover.ts` 40 uses, `app.ts` 30). The minified one-line style in `users.ts` makes the deletion and admin code hard to review.

- **Not recommended now.** There is no migration tool and the live DB has real data. Replacing DDL with generated migrations is a larger decision. Recorded for the ADR list below.
- **Cheap, safe step:** a test that compares `PRAGMA table_info` for each table in a fresh DB against the Drizzle table definitions, so drift between the two files fails the build. This also covers candidate 2's discovery of per-user tables.

## Suggested order

1. Candidate 2 (user deletion registry and test). Small, additive, closes a latent data-exposure risk.
2. Candidate 1 (route access policy). Mechanical and high leverage for future routes.
3. Candidate 7's drift test (cheap, and supports 2).
4. Candidate 3 (`saveProgress`), then candidate 4 (Hardcover split) using the same test approach.
5. Candidates 5 and 6 as code-motion passes after the above.

## Not recommended

- **`server/chapters.ts`, `range.ts`, `media-response.ts`:** small modules with narrow interfaces and pure functions. They pass the deletion test and are already testable in-process. Leave them.
- **`server/media-library.ts`:** read in full. It mixes route handlers with the fault and copy rules, but at 163 lines it is cohesive. A deeper `RecordingSources` module would add indirection without a second adapter.

## Terms and decisions to record (not yet written)

Candidates that would need the user's agreement before touching `GLOSSARY.md` or adding ADRs:

- **Glossary:** "Admin-only route" (candidate 1), "Per-user table" (candidate 2), "Outbox" for the durable Hardcover queues (candidate 4). Existing glossary entries use none of these terms.
- **ADR candidates:** (a) additive-only schema with dual definitions, and what would justify moving to migrations (candidate 7); (b) access rules declared at route registration (candidate 1).

## Not verified in this review

Bodies of `server/alignment.ts`, `server/acquisitions.ts`, `server/downloads.ts`, `src/player.tsx`, `src/reading.ts` and `src/components/Reader.tsx` were not read, so no claims are made about them beyond file size. They are the next places to apply the same deletion test, particularly `alignment.ts` (1,266 lines with `processAnchored` and `processAlignments` as long functions) and `Reader.tsx` (1,868 lines).

---

# Update 2026-11-09: status of candidates and new findings

Method: same vocabulary (`codebase-design`), CodeGraph plus targeted greps. Nothing was changed in code. 399 commits landed since the first review, mostly alignment, series and ebook-set work.

## Status of the 2026-11-02 candidates

All seven candidates are still open (**Verified** by grep: no `saveProgress`, no user-table registry, and the admin regex is still at `server/app.ts:295`; it has grown, now covering `/api/works/:id/ebook-set/fetch` and `/api/alignments/*` as well).

- Candidate 1 got worse: the regex list gained entries since the first review, which is the failure mode the review predicted. It should be the first thing done.
- Candidate 4 is larger: `server/hardcover.ts` is 2,610 lines (was 1,988) and now imports series, acquisition, download and ebook-set modules, so it is also a hub for series work, not just the Hardcover transport.
- Candidate 5/6: `server/app.ts` is 1,343 lines and `src/App.tsx` 3,053 lines. Both grew.

## New candidates

### 8. `server/alignment.ts` (1,939 lines) is five modules in one file

**Verified from the function list, bodies partly read.** One file holds: the job store (`readJob`, `store`, `putAlignmentJob`), eligibility and backfill (`alignmentOptions`, `backfillEligibility`, `runAlignmentBackfill`, `autoQueue*`), worker transport and capability probing (`workerRequest`, `workerSupportsAnchorBatch`, retry clocks), the runner (`processAnchored` ~410 lines, `processAlignments` ~390 lines), and HTTP routes (`registerAlignment`). Six server files import it (`app.ts`, `reader.ts`, `ebook-set*.ts`).

- **Deletion test:** deleting it spreads job persistence, worker calls and queueing across all those importers, so it earns its place. The weakness is that the interface is the whole export list (28 exports), including test-only hooks (`setWorkerRetryClockForTests`, `setAnchorBatchClockForTests`, `resetAnchorBatchSupportForTests`, `resetAlignmentRunnerForTests`). Test-only exports are a sign that tests have to reach past the interface.
- **Seam worth making real:** the alignment worker transport (`workerRequest` and the anchor-batch capability memo). It is true-external (the Python worker) and already has two adapters in practice: the real worker and the fixtures in `tests/*-fixture.ts`. A `WorkerClient` module taking its clock as a dependency removes the four test-only hooks.
- **Suggested split by locality:** `alignment-jobs` (store), `alignment-queue` (eligibility, backfill, auto-queue, which is what `reader.ts` and `ebook-set` actually need), `alignment-worker` (transport), `alignment-runner` (the two `process*` loops), with `registerAlignment` last. Re-export from `alignment.ts` first so importers do not change in one step.
- **Risk:** medium. Alignment maps are expensive to regenerate and CTC jobs run for a long time. Move code without editing the `process*` bodies; the existing `tests/alignment-ctc.test.ts` is the guard.

### 9. Import cycles among `alignment`, `reader` and `hardcover`

**Verified.** `alignment.ts` imports `extractBook` from `reader.ts` (line 16), and `reader.ts` imports `autoQueueAlignmentsForWork` from `alignment.ts` (line 1). `reader.ts` also imports `queueHardcoverReadingProgress` from `hardcover.ts`, and `hardcover.ts` imports `listEbookSetMembers` from `ebook-set.ts`, which imports `alignment.ts`. The cycles work only because the imports are used inside functions, not at module load.

- **Problem:** the load order is an unwritten part of each interface. A top-level use of an imported value would fail depending on which file loads first. It also blocks candidate 8, since the split must not harden a cycle.
- **Deepened shape:** `reader.ts` should not call the queue directly. Two options: the reader module exposes `extractBook` from a lower-level `ebook-text` module (no alignment import), or `autoQueueAlignmentsForWork` is passed to reader code as a hook registered at startup. The first is simpler and has no new seam.
- **Tests:** add a check (for example `madge --circular server` or a small import-graph test) so new cycles fail the build. The repo has no linter today, so this would be the first structural check.
- **Risk:** low.

### 10. Four background tickers are started by hand in two places

**Verified.** `server/app.ts:909-930` creates three `setInterval` timers (queue poll, series acquisition, Hardcover) and `server/alignment.ts:1932` creates a fourth for `processAlignments`. Shutdown handling lives with each. This is the `startBackgroundWork` idea from candidate 5, now with a concrete reason: one place should own start, stop and the "tests disable tickers" switch.

- **Risk:** low. Do it together with candidate 5.

## Revised suggested order

1. Candidate 1 (route access policy). The regex keeps growing, and a missed entry exposes an admin route.
2. Candidate 2 (user deletion registry and test), with candidate 7's drift test.
3. Candidate 9 (import cycles) then candidate 8 (split `alignment.ts`).
4. Candidate 3 (`saveProgress`), then candidate 4 (Hardcover split).
5. Candidates 5, 10 and 6 as code motion.

## Still not verified

Bodies of `server/series-*.ts`, `server/ebook-set-consensus*.ts`, `server/acquisitions.ts`, `server/downloads.ts`, `src/player.tsx` and `src/components/Reader.tsx` were not read. Each is large and recent; apply the deletion test to them next.

## Glossary and ADR additions proposed (not written)

- Glossary: "Alignment job", "Worker client" (candidate 8), plus the three terms listed above.
- ADR: no import cycles between server modules (candidate 9).
