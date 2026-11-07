# Issue #280: WebKit long-press after resize

Investigation on 2026-11-07. The failure has not been reproduced or fixed, and
its cause remains unknown.

## Proposal and evidence

- **Reproduce the WebKit failure:** the test passed 30/30 repetitions on base
  commit `3dbfae5aec201792b026f9b1ab25a7ad7c8fa0b0` and 30/30 on the original
  failing commit `99c0120041c82536351b04ceee3f1973851b13a6`. Both used a build
  of the corresponding revision and the command below. The original-commit run
  overlapped the full unit suite and typecheck, adding machine load. The two
  revisions have identical lockfiles and reader-frame specs.

  ```sh
  PLAYWRIGHT_PORT=4280 npx playwright test tests/e2e/reader-frame.spec.ts \
    --project=webkit --grep 'long-press reaches a sentence after the reader is resized' \
    --repeat-each=30 --workers=1 --retries=0 --max-failures=1
  ```

  The local machine lacked WebKit libraries, so the runs used copies of the
  missing Ubuntu libraries in a temporary directory and a temporary wrapper
  around the installed Playwright WebKit binary. Playwright's host dependency
  validation was disabled for those runs because it checks the system library
  cache; the browser ran with the temporary library path. This differs from the
  original WSL host environment.
- **Distinguish test timing from an app bug:** unresolved. The original report
  contains only `Error: expect(received).toBe(expected) // Object.is equality`;
  the coordinator confirmed that its full stack and trace were cleaned up.
  Passing repetitions do not identify which assertion failed or rule out a
  reader defect, a test race, or a host-specific issue.
- **Fix deterministically or document an inherent/unfixable failure:** no fix
  or inherent WebKit behavior has been established. The existing test and
  known-failures files remain unchanged. A future failure needs its full
  Playwright stack and trace preserved before choosing a fix.

The focused sandbox tests passed (`npx tsx --test tests/reader-sandbox.test.ts`,
5 tests), as did `npx tsc --noEmit` and `npm test` (1,410 tests). These checks
do not determine the cause of the original browser failure.

## Conditional known-failure entry

Do not add this entry on the basis of the evidence above alone: matching uses
project, file, and title, so it would tolerate any failure of this test, not
just the original assertion. If further evidence establishes an intermittent
WSL-only failure and it cannot be fixed, the entry for
`tests/known-failures.wsl-host.json` would be:

```json
{
  "project": "webkit",
  "file": "tests/e2e/reader-frame.spec.ts",
  "title": "long-press reaches a sentence after the reader is resized",
  "kind": "intermittent",
  "reason": "WSL WebKit failed once in run sonder-ci-20261106T191935Z-1400654; the assertion location and cause were not retained. Both the original commit and a later branch passed 30 local repetitions each.",
  "issue": 280
}
```
