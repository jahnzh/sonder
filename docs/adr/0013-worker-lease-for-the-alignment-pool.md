# The alignment pool hands out worker leases

Code that needs an alignment worker asks the pool for a **worker lease** and gets back a healthy host with the recording's tracks staged on it, plus the base address to call. The caller runs its requests and releases the lease, saying whether the work is finished or will be retried. Health checks, slots, staging over SSH, the choice of host, the retry on the other host and re-staging after a worker restart all happen inside the pool. Alignment jobs and ebook-set probes use the same lease.

Hosts are described by configuration, not by name in code. One setting lists each host with its id, SSH target, worker address, device and precision, and its rank; today's WSL (GPU, first) and lisa (CPU, fallback) are the default value. No code outside the configuration compares a host id with a literal.

The lease records what it staged and where. A job's stored assignment names every host it staged its tracks on and the folder there (`pool.stagedHosts`), across requeues, Resume, a new plan and server restarts, also for a host that is not configured at the moment. Releasing a lease as finished (the job is ready, partial, failed for good or cancelled) marks that staging as no longer needed; releasing it as retryable (paused, or a failure the scheduler retries) keeps it for the next run. Neither deletes anything on the hosts. Removing staged job audio is #421 and runs inside the server, under leases; until then staged job audio stays on the hosts, as it did before this change. Deleting was taken out of this change because two reviewed attempts showed a delete can outlive the claim that protected it: a remote removal still running after its deadline (a plain `rm`, then a rename before the `rm`) could reach the folder a later run of the same job had staged into. A probe's staging is a folder of its own that nothing reuses, and its release removes it, as before leases. Confirmed on 2026-11-14: staged job audio was never removed (32 job folders on WSL); only probe leases cleaned up after themselves.

## Considered options

- **Keep dispatch, busy handling and release in the callers.** The same block existed four times in `server/alignment.ts`, with five release sites.
- **Wait for the whole-book request (#389).** One request per lease makes callers simpler still, but the lease interface does not depend on how many requests run under it, and #389 needs a re-qualification that may take longer.

## Consequences

- Order: after #393, before the server side of #389.
- Staged job audio, from before this change and after it, stays on the hosts until the server removes it under leases (#421); do not delete it by hand while jobs run. A one-time sweep command outside the server was tried and dropped: it could delete a resumed job's or a running probe's audio.
- Tests run against a fake pool host (in-process, no SSH): acquire on the first healthy host, fall back when it is down or full, re-stage after a restart, release on every exit path including a thrown error, a job's staged audio kept on every release with a record of every host it staged on, and a probe's staging removed on its release.
- Worker status, restart and per-host disable on the Activity page (#357) read the same host configuration.
- Issue: #394.
