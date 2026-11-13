# Issue 373 report

> **Historical note.** This records the #373 investigation on 2026-11-13 and is not current instructions. Sonder is live at https://sonder.pecori.no (Caddy → 127.0.0.1:3001); see `README.md` for the current setup.

## Root cause

In `processAnchored`, a successful `/anchor-batch` path ended with `continue`, and the next loop iteration hit `if (!pending.length) break` once every sample was marked done. That skipped `selectAnchors` and segment planning, so matched samples never became anchors and the map stayed empty (coverage 0). The same early break also blocked resumed jobs whose samples were already complete.

## Bisect

Structural oracle between good `18a4778` (2026-11-07) and deployed `23c0dee`:

- bad `dad41ce`, bad `ea09f39`, good `ac083b8`, bad `32c6949`, bad `d0f3994`
- first bad: `78c1b62` (batch sampling)

Fix commit on this branch: `f1a83d4` (removes the early `break` / `continue`).

## Regression test

`historical Earth Awakens batch samples advance to anchored alignment` in `tests/alignment-ctc.test.ts`, fixture `tests/earth-awakens-ctc-samples.json` (103 historical samples, 98 matched).

- Without the fix: fails with `selected 0 anchors`
- With the fix: passes

## Checks (final revision)

- `npx tsx --test tests/alignment-ctc.test.ts`: 19 pass
- `npm run build`: pass
- `npm test`: 1671 pass, 0 fail
- Browser tests / `npm run check`: not run (coordinator)

## Real-media Earth Awakens (WSL, owned worker port 31173)

Pair: ebook `libgen-ee7ab30a8874644c0e0c6db444bbc5c3`, recording `recording-local-1a605b4b1b1b52cc0b8a05db7a05c02d3c63139e`.

| Run | Code | status | outcome | matched | anchors | intervals | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before | main snapshot (`/tmp/sonder-issue373/baseline`, has the bug) | partial | unsynced | 98 | 0 | 0 | 0 |
| after | this branch (`f1a83d4`) | partial | partial | 98 | 98 | 14229 | 0.9577303627919499 |

Historical production job `506bb13c-9383-4610-9f50-9b48a788d21b` still records coverage 0.9850575486302753 with 98 anchors (not re-run here).

## Production backfills that need rebuild (not re-run)

Zero-interval CTC `origin: backfill` jobs with matched samples (this bug class):

1. `546d8eee-7320-4a05-a125-c6db5f1f960c` / `recording-local-3b4cbf70…` (184/296 matched)
2. `17a39c0b-8adc-4116-81ae-82aaad24ab3c` / `recording-torbox-129969003` (58/67)
3. `0d3aff3f-b3bc-4fc5-9797-a3854f5e0c67` / `recording-local-134ce691…` (859/911)
4. `a71d3970-28d2-4410-a3e7-ca00acda53c5` / `recording-local-0db50534…` (801/838)
5. `70e1d020-9681-482d-8b02-d3821450d034` / `recording-torbox-141788941` (228/232)
6. `3dd1b336-8e62-4ad6-94ff-6897a0ed10ff` / `recording-local-7945edec…` (689/718)

Example `139c4ed3…` / `recording-torbox-128622025` has 124 samples and **0** stored matches, so it is not assumed to be this cause. No production job was rebuilt.

## Not verified

- Real-media run of the zero-match backfill example (`recording-torbox-128622025`)
- Production rebuild of the six matched backfills
- Browser tests / committed `npm run check`
- Claiming the new after-run equals the historical 0.985 figure (after was 0.958)

## Cleanup

Owned WSL worker on port 31173, SSH tunnel `127.0.0.2:31173`, directory `~/sonder-replication/issue373-wXxRdU`, and `/tmp/sonder-issue373` removed after the runs. Production CTC worker on 3012 was not touched.
