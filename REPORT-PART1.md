# Issue #577 report — incomplete

Commit: b501be22ae5aadb37d4c077b45b9cbc6cb21da43. Outcome: failed; this branch is a partial implementation and is not ready to land.

The local issue bundle contains only #577 and #572. The requested decision tickets #455, #456, #467, #470–#473 and their resolutions were unavailable; I used the decisions recorded in #572. No server schema change was made. The device database adds version 7, preserving the old favourites preference and writing work favourites separately.

## Proposal, sentence by sentence

- Library reads stored works with device places, one tile per work, without using the books read for its tiles: implemented using `useStoredWorksWithPlaces`; `library-redesign.spec.ts` opens a work and `library-filter.test.ts` exercises works. The application still reads `/api/books` for other features.
- Head: Library title, local title/author search, plus to Discover: implemented; the browser spec covers title and search. Focus in Discover is not wired or verified (ticket 03 owns focus).
- Continue: newest in-progress place on All without search or Hardcover filter: implemented with `latestPlace`; browser coverage of its selection and appearance is missing.
- Chips: All, Series, In progress, Not started, Finished, On device, Favorites; remembered, heading names it: implemented with `filterLibrary`, stored chip and existing Series list. Unit tests cover all except Series. Browser spec checks persistence of Finished. Full chip fixture and second-account coverage are missing.
- Tiles: cover, title, author, cover marks or download percentage; opens work: implemented using `coverMarks`; browser spec checks navigation. Marks and downloads are not verified in the new browser spec.
- Favourites migration and Book Favorite by work: implemented in Dexie v7 and Book page; `favorite migration maps editions including placeholders and drops unknowns` covers mapping as a pure function. An actual upgrade preserving all device data, an older tab, and the Book page toggle have not been verified.
- Empty states: implemented `No books`/Clear filters and `No books yet`/Find a book; no browser coverage yet.
- Removed old heading, tabs and drawer favourites; retained sort, view and Hardcover controls: implemented in the Library, but old unused styles remain and other old browser specs still expect the former screen. The retained list view lacks its specified place lines and muted marks. The plus does not focus Discover.

## Acceptance criteria

- Unit fixture for each chip, migration and search: partial. `npx tsx --test tests/library-filter.test.ts` passed; fixture does not establish actual downloads, full ebook/PDF marks, or actual Dexie upgrade.
- Browser board measurements, one work for two recordings, all marks and chips, Continue, favourites migration and preservation of places/downloads/history: incomplete. `tests/e2e/library-redesign.spec.ts` checks phone overflow and dark ground, search, chip persistence, navigation; captures phone and desktop screenshots in OUT. It does not cover the remainder.
- Spec guards 1–3: guard 1 is covered by the new browser spec; guards 2 and 3 have not been rewritten and verified. Existing `app.spec.ts` still expects the old UI.
- New browser spec in Chromium and Firefox: passed on port 4755 (`PLAYWRIGHT_PORT=4755 npx playwright test tests/e2e/library-redesign.spec.ts --project=chromium --project=firefox`). An initial run failed due to duplicate search fields; the corrected run passed.
- `npm run check -- --ref <commit>`: not run, as SPEC explicitly prohibits it. No committed isolated check has been performed.

## Verification and decisions

- `npm run build` passed before the last progress-sort adjustment; the commit hook ran `npx tsc --noEmit` successfully on the committed files. `node scripts/check-server-catches.mjs` passed as part of the build. No server files changed.
- Mutation proofs: replacing Favorites membership with false and replacing the In progress predicate with false both produced `CAUGHT` against `tests/library-filter.test.ts`. Other new behaviours lack mutation proofs.
- `npm test` was started locally; see final status below.
- No stress run or committed check was run, per SPEC. No second-user response tests were added because no server responses changed; account-switch and actual upgrade behaviour still require verification.
- Choices: the selected chip is stored in localStorage as a device preference; old edition favourites are retained under their original key for older clients; multiple edition ids map to one work. Search uses a case-insensitive substring of title and author. Continue chooses the newest timestamp across separate recording and ebook places, without merging positions. Progress sorting uses the highest individual place fraction.
- Known remaining work: finish the list presentation and visual alignment with both boards; add all requested fixtures, actual upgrade and two-user browser tests; rewrite and run the existing guards; cover all marks, Continue, filters and favourites in both browsers; remove obsolete styles; run remaining mutation proofs and the final committed check. Review loading/error and offline states, since the new shelf currently renders an empty state while the stored read has not arrived or fails.
- The full `npm test` run did not finish; it was interrupted after several minutes, so there is no suite result. A final build on the exact commit was not run; the successful build preceded the final progress-sort edit. The commit hook typechecked the committed revision.
