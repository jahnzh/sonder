# Issue #577 report — incomplete

Outcome: failed. Commit: 2836d67 (on top of b501be2). The work is not ready to land: several acceptance criteria lack evidence, old browser guards fail, and the committed isolated check is expressly prohibited by SPEC.md. No server schema change was made. Dexie version 7 is additive; it retains the old favorites preference and stores work favorites separately.

## Proposal

- Stored works with device places, one tile per work, no books read for tiles: `useStoredWorksWithPlaces` and `library-redesign.spec.ts` navigation. The application still fetches `/api/books` for other features; no assertion proves the Library makes no request.
- Library title, local title/author search, plus to Discover: `library-redesign.spec.ts` checks title and title search; `library-filter.test.ts` checks author search. Discover focus is not wired (ticket 03 owns it), and the plus is not covered by this spec.
- Continue newest in-progress place on unfiltered All: `latestPlace` and the In progress fixture are covered by `library-filter.test.ts`; selection and visibility are not browser tested.
- All, Series, In progress, Not started, Finished, On device and Favorites; selected chip remembered and heading named: `library-filter.test.ts` covers non-Series chip predicates; `library-redesign.spec.ts` checks Finished persistence; Series has its own browser spec. Real complete Keep entries and all chip combinations lack the requested fixture proof.
- Cover, title, author, marks or download percent and work navigation: `library-redesign.spec.ts` checks navigation; `cover-marks` and work-progress unit tests cover underlying functions. The complete visual marks fixture, one tile for two recordings, and download percentage remain unverified in the browser.
- Favorites migration from edition ids including placeholders, and Book Favorite by work: `favorite migration maps editions including placeholders and drops unknowns`, and `upgrade maps edition favorites and preserves device records`; `favorite persists by work and list view shows the place` checks the Book toggle and reload. Older open-tab behavior is unverified.
- No books / Clear filters and No books yet / Find a book: present in LibraryPage; browser evidence is missing.
- Remove old heading, tabs, drawer favorites and Library books read and their styles, retain sort, view and Hardcover: old heading and tabs replaced; drawer behavior and obsolete styles remain to be reviewed. Sort, view and Hardcover controls remain. The list now renders the Book place line and muted marks; the new browser test checks a place line but not all row variants.

## Acceptance criteria

- Unit fixture for all chips, migration and search: partial. `tests/library-filter.test.ts` covers chip predicates, ebook place, title and author search, migration including placeholders and unknown ids; downloading and device states are synthetic, and Series is separate.
- Browser measurements and fixture: partial. `library-redesign.spec.ts` checks phone overflow and dark background, desktop and phone screenshots, search, reload, favorite toggle and real Dexie upgrade preserving old favorite preference, progress, a download and position history. It does not establish board measurements, two recordings as one tile, every mark and chip, Continue, or all requested upgrade cases.
- Spec guards 1–3: guard 1 passes in new spec; guard 2 covered by the favorite/reload test; guard 3 (empty Finished) is not verified in new form. Old app.spec.ts still uses the removed tab.
- New specs in Chromium and Firefox: the three Library tests passed in both browsers after fixing a malformed download fixture (`/tmp/sonder-577-new-browser2.log`).
- `npm run check -- --ref <commit>`: not run, because SPEC explicitly prohibits it.

## Verification and decisions

- `npm test`: an earlier run passed 2,974 tests; the final-commit run failed one of 2,975 tests: `pre-push hook starts no committed check for a push that does not land` (`tests/pre-push-hook.test.ts:411`). `npx tsx --test tests/library-filter.test.ts`: passed, three tests. `npx tsc --noEmit` passed, and the commit hook typechecked the final commit. `npm run build` and `node scripts/check-server-catches.mjs` passed. No stress run or committed isolated check, per SPEC.
- Mutation proofs: prior worker reported caught mutations of Favorites and In progress predicates. Search and latest-place mutations were caught by `tests/library-filter.test.ts` (logs in OUT). Other changed behavior, including the new list display and actual upgrade, lacks mutation proof.
- Decisions: device-local chip preference; preserve old favorites for older clients; collapse multiple edition IDs to one work; case-insensitive title/author substring search; Continue compares individual timestamps without merging places; progress sort uses the highest individual fraction. The list uses Book's existing `placeLine` and muted cover marks. Separate controls remain pending ticket 06.
- Decision issues #455, #456, #467, #470–#473 were absent from ISSUES/; the parent spec's recorded decisions were used. There is no production verification. No new server response was changed, but second-user UI verification of this change remains incomplete.

## Final browser runs

On the final build, the selected Chromium library, works-gallery, series and navigation specs finished with 40 passed and 35 failed (`OUT/browser-chromium.log`). Firefox's Library specs finished with six passed and six failed (`OUT/browser-firefox.log`); all three new Library tests passed in both. The original Chromium run covering Keep and the other named files was interrupted after it stopped reporting for over two minutes in `keep-not-complete.spec.ts`; two ebook-only tests had failed and ten tests had passed. A subsequent remaining-files run was interrupted when a rebuild replaced its served assets, so it does not establish a clean Keep result. No stress run was performed. Some old failures explicitly wait for `Your library.` or the old Listening tab; for example the works-gallery second-user test stopped at the old heading before its isolation assertion. Other failures have not been diagnosed and cannot be dismissed as stale selectors. Browser logs and screenshots are in `OUT/`.
