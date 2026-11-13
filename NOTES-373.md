# Issue 373 handover (complete)

The defect is in `processAnchored`: the successful `/anchor-batch` path used `continue`, then the next loop iteration hit `if (!pending.length) break`, bypassing `selectAnchors` and segment planning. The same early break also prevents resumed jobs whose samples are already complete from advancing. The fix removes both exits (`f1a83d4`), preserving the existing single-sample fallback and allowing completed samples to reach selection. The outlier rule and scheduler were not changed.

## Bisect

Structural oracle between good `18a4778` (2026-11-07 UTC) and deployed `23c0dee`: bad `dad41ce`, bad `ea09f39`, good `ac083b8`, bad `32c6949`, bad `d0f3994`, first bad `78c1b62` (batch sampling).

## Regression test

`historical Earth Awakens batch samples advance to anchored alignment` (`tests/earth-awakens-ctc-samples.json`). Fails without the fix (`selected 0 anchors`); passes with it.

## Checks on final revision

- `npx tsx --test tests/alignment-ctc.test.ts`: 19 pass
- `npm run build`: pass
- `npm test`: 1671 pass, 0 fail
- No browser tests or `npm run check` (coordinator)

## Real-media Earth Awakens (done)

Isolated WSL worker (port 31173, dir `issue373-wXxRdU`) — production workers untouched.

| | before (buggy main snapshot) | after (fix `f1a83d4`) |
| --- | --- | --- |
| matched / samples | 98 / 103 | 98 / 103 |
| anchors | 0 | 98 |
| intervals | 0 | 14229 |
| coverage | 0 | 0.9577303627919499 |
| outcome | unsynced | partial |

Historical production job `506bb13c-9383-4610-9f50-9b48a788d21b` still shows coverage 0.985 (not claimed as a new run).

## Backfills needing rebuild (not re-run)

Six zero-interval CTC backfills with matched samples:

- `546d8eee-7320-4a05-a125-c6db5f1f960c` (`recording-local-3b4cbf70…`, 184 matched)
- `17a39c0b-8adc-4116-81ae-82aaad24ab3c` (`recording-torbox-129969003`, 58)
- `0d3aff3f-b3bc-4fc5-9797-a3854f5e0c67` (`recording-local-134ce691…`, 859)
- `a71d3970-28d2-4410-a3e7-ca00acda53c5` (`recording-local-0db50534…`, 801)
- `70e1d020-9681-482d-8b02-d3821450d034` (`recording-torbox-141788941`, 228)
- `3dd1b336-8e62-4ad6-94ff-6897a0ed10ff` (`recording-local-7945edec…`, 689)

`139c4ed3…` / `recording-torbox-128622025` has zero stored matches — different failure mode; not assumed this bug. Full report: `docs/handoff/issue-373-report.md`.

## Cleanup status

Terminate owned WSL worker, SSH tunnel, delete `~/sonder-replication/issue373-wXxRdU` and `/tmp/sonder-issue373` after verification (see completion commit).
