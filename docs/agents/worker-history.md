# Worker history

`node scripts/orca-history.mjs` keeps a local record of what happened to each worker and a reference copy of its transcript (#111, part of #103). It reads Orca and writes only to its own directory. It never starts, stops or messages a worker, and it sends nothing over the network.

```sh
node scripts/orca-history.mjs capture --dispatch <id> [--recommendation <file>] [--kind <kind>] [--files <n>]
node scripts/orca-history.mjs record-check  --dispatch <id> --name <name> (--result <result> | --report <report.json>)
node scripts/orca-history.mjs record-review --dispatch <id> [--blocking <n>] [--high <n>] [--medium <n>] [--low <n>]
node scripts/orca-history.mjs link --from <later> --to <earlier> --kind fix_of|review_of|retry_of --evidence "<why>"
node scripts/orca-history.mjs record-shared-usage --provider <agent> --before <obs.json> --after <obs.json> --workers <id,id>
node scripts/orca-history.mjs list | show --id <id> | transcript --id <id>
node scripts/orca-history.mjs delete --id <id>      # one record with its transcript, or one shared usage change
node scripts/orca-history.mjs delete --all --yes
```

Run `--help` for every option. The directory is `--dir`, else `ORCA_HISTORY_DIR`, else `artifacts/orca/history` (gitignored). Each record is one JSON file named for the dispatch, so it survives restarts and is replaced atomically. Files are readable only by the owner.

## When to capture

Capture after the worker reports `worker_done` and **before** `worker-release`, and again after checks or reviews so the lifecycle is complete. Capturing is repeatable: it merges, appends a lifecycle event only when the state changed, and never replaces a known value with `unknown`.

```sh
node scripts/orca-recommend.mjs --task <n> --summary "<…>" --kind feature > artifacts/orca/recommend-<n>.json   # at selection time
node scripts/orca-history.mjs capture --dispatch <dispatch_id> --recommendation artifacts/orca/recommend-<n>.json
node scripts/orca-history.mjs record-check --dispatch <dispatch_id> --name "npm run check" --report <report dir>/report.json
```

## What a record holds

| Field | Source |
| --- | --- |
| Agent, requested and effective model and effort, base and worker branch, host | `orca orchestration worker-show` |
| Lifecycle (status, worker state, outcome, times, events), elapsed time, failure count, retry of | `worker-show`; elapsed only once the dispatch has completed |
| Task type and size | `--kind`, `--files`, or the `request` of the recommendation file |
| Difficulty, who assessed it (`jev` or `coordinator`), Jev version and uncertainty, selection, override with reason, whether the launch matches the decision | the recommendation file |
| Agent version | `--agent-version`, else the version installed on this host at first capture (it may differ from the one the worker ran) |
| Checks | `record-check`; `--report` reads an `npm run check` `report.json` |
| Review findings | `record-review`, per severity; a severity you do not give is `unknown` |
| Follow-up fixes, reviews and retries of other workers | `link` with evidence, or Orca's `retryOfDispatchId` |
| Usage | see below |

Anything Orca or the coordinator did not provide is `unknown`. Unknown is not zero: no checks recorded is not "checks passed", and no linked fix is not "no fix was needed".

The quality signals are kept separate: completion (the worker's reported outcome), checks, reviews, follow-up fixes, retries and elapsed time. There is no combined score; a worker that succeeded with a failing check shows both. An override records the coordinator's choice and the recommendation side by side; it does not mark either one wrong.

Records are not linked by guesswork. `link` needs both records to exist and a stated reason, and the later work is `--from` (the fix, the review or the retry). A later outcome is shown on the earlier record only through such a link.

## Usage

- **Attributable usage** (`record-usage`) is for a per-worker meter. None of the four readers provides one today, and `worker-read` carries no token counts, so this stays `unknown` unless you record a figure from a meter that belongs to that worker alone.
- **Shared usage** (`record-shared-usage`) keeps the change between two reader observations of one allowance, per window, with the workers that ran on that agent in between. It is stored once, as a shared change, with `perWorkerCost: "unknown"`. The allowance is shared with the user's own sessions and with every listed worker, so the change is never divided or assigned to a worker. A window whose `resetsAt` moved between the readings has no change recorded. Observations must come from the same provider and account; a worker on another agent is refused.

## Transcripts

`capture` stores the worker's transcript (or its terminal tail when Orca has no transcript) in `transcripts/<id>.jsonl`, apart from the record. Credentials are removed before anything is written: the values of environment variables whose names contain KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL, bearer and basic headers, private keys, and common token shapes. This is pattern matching, not a guarantee; do not rely on it for a secret it cannot recognise.

Transcripts are for investigating a past outcome. `list` and `show` never print them, the record holds only metadata (count, source, whether Orca clipped it), and `scripts/orca-recommend.mjs` sends Jev only its summary, kind and file count. Planning and learning read records, not transcripts. Orca bounds what `worker-read` returns; when it clips, the record says `complete: false`. Capture before releasing a worker so Orca can still read it.

## Inspect and delete

`list` summarises every record, `show` prints one record or shared usage change, and `transcript` prints the stored transcript. `delete --id` removes a record with its transcript (it also removes the worker from shared usage changes, and links to it then show `targetState: "not recorded"`) or one shared usage change. `delete --all --yes` removes everything. Deleted data is gone: the files are removed, not archived.

## Not covered

- The history is read by people and by later work on recommendations; nothing in `orca-recommend.mjs` reads it yet.
- Capturing and recording are manual steps: nothing runs them at `worker_done`.
- Concurrent writers to one record are not coordinated beyond atomic replacement; capture one dispatch at a time.
