# The alignment pool hands out worker leases

Code that needs an alignment worker asks the pool for a **worker lease** and gets back a healthy host with the recording's tracks staged on it, plus the base address to call. The caller runs its requests and releases the lease, saying whether the work is finished or will be retried. Health checks, slots, staging over SSH, the choice of host, the retry on the other host and re-staging after a worker restart all happen inside the pool. Alignment jobs and ebook-set probes use the same lease.

Hosts are described by configuration, not by name in code. One setting lists each host with its id, SSH target, worker address, device and precision, and its rank; today's WSL (GPU, first) and lisa (CPU, fallback) are the default value. No code outside the configuration compares a host id with a literal.

The lease owns the staged audio. Releasing a lease as finished (the job is ready, partial, failed for good or cancelled) removes the job's staged tracks from the host. Releasing it as retryable (paused, or a failure the scheduler retries) keeps them. Confirmed on 2026-11-14: staged job audio was never removed (32 job folders on WSL); only probe leases cleaned up after themselves.

## Considered options

- **Keep dispatch, busy handling and release in the callers.** The same block existed four times in `server/alignment.ts`, with five release sites.
- **Wait for the whole-book request (#389).** One request per lease makes callers simpler still, but the lease interface does not depend on how many requests run under it, and #389 needs a re-qualification that may take longer.

## Consequences

- Order: after #393, before the server side of #389.
- Folders staged before this change are removed by a one-time sweep that only deletes a folder whose job is finished or no longer exists. The sweep runs on request, not at startup.
- Tests run against a fake pool host (in-process, no SSH): acquire on the first healthy host, fall back when it is down or full, re-stage after a restart, release on every exit path including a thrown error, and removal of staged audio on a finished release only.
- Worker status, restart and per-host disable on the Activity page (#357) read the same host configuration.
- Issue: #394.
