# Alignment job transitions live in one module

Every change of an **alignment job**'s status goes through one server module that exposes a named function per transition: queue, start, record progress, publish, fail, pause, resume, cancel, queue a **rebuild**, reject a rebuild, and project. No other module writes `alignment_jobs.data`, its status, or the kept published map. The scheduler's claim columns stay with the scheduler, because a claim is a lease on a row and not a state of the job.

The questions "is this job active", "does it have a usable map", "may it be retried" are answered by predicates defined once, next to the status type in `src/reading-types.ts`. The server and the client both import them from there. That file is already one of the three `src/` files the production image copies, so no new file crosses that boundary.

A projected map from an ebook-set consensus is a transition of the member's own job (`project`), not a separate kind of job. The member's row records which consensus job it was projected from. The transition applies the same publish rule as a rebuild (ADR 0006 as amended by #379): a projection that is empty or much worse than the member's kept map does not replace it.

## Considered options

- **A second kind of job for projections.** Every reader would then have to know two kinds, which is the duplication this decision removes.
- **Keep a client copy of the predicates.** It drifted before: "active" was defined six times, with differences.
- **Wait for the whole-book request (#389).** That removes most of the runner but none of the transitions; the new runner is simpler to write against named transitions, so this comes first.

## Consequences

- Order: after #279 and #379 have landed (both rewrite the same code), before #389.
- Raw SQL updates of job status outside the module (`server/series-removal.ts`, the hand-built job in `server/ebook-set-consensus.ts`) are replaced by calls to it.
- A table-driven test lists every allowed transition and asserts that every other pair is refused; each caller's behaviour is pinned by the existing alignment tests.
- The wire shape of a job does not change, so open older client builds keep working.
- Issue: #393.
