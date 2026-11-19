# Only an edition someone reads is synced whole

An ebook search fetches EPUBs into a work's ebook set to find the one that matches the narration (ADR 0004, ADR 0005). Until #718 every edition the set kept was then synced whole by itself, spares included: the backfill, the check that ended and the arrival of server audio each queued a whole-book alignment for every (edition, recording) pair. On lisa's CPU a whole book takes hours, so a set of five cost a day of CPU for editions nobody opens, and Activity showed finished books "Encoding audio" again (*The Hydrogen Sonata*, *Consider Phlebas*, 18 Nov).

Decision: a spare edition needs no whole-book sync. What the set needs from each edition is its check against the narration, and that is the probe (the outlier check of `evaluateEbookSetMember`, a few sampled windows on one staging), not an alignment. An accepted edition reads the set's consensus map through its projection, which costs one whole-book alignment for the whole set. So:

- Nothing queues a whole-book sync by itself for a **spare edition**: an EPUB of the work that is not read. An edition is **read** when it is the work's shared default, when any account has a place in it, or, without a shared default, when it is the work's first EPUB (the one Read opens). `server/ebook-chosen.ts` holds the rule; the backfill and the auto-queue skip a spare edition (`skipped.spare`), and the automatic engine rebuild leaves a map the backfill made for one.
- Prepare still syncs any edition on request, and a map the administrator prepared is rebuilt as itself. An edition someone starts reading is read from then on, and the next backfill or rebuild scan syncs it.
- An ebook search fetches one edition, checks it, and fetches the next only when that one fails the narration check (rejected) or its download or check fails; at most `EBOOK_SET_TOP_K`. An edition held because there is no audio or no worker yet has not failed, so it ends the fetch. Each check has its own probe session, released before the next download, so the lease is never held across a LibGen transfer; more than one staging happens only after a rejection.
- Activity calls a reading sync of a spare edition that was queued by itself "Checking another edition", one row per book ("Checking 4 other editions · 1 of 4"), under Waiting, never In progress, and does not list it under Finished today. One that stopped still needs attention.

## Considered options

- Keep syncing every member and only relabel it in Activity. Rejected: the CPU is the cost the owner saw, not the label.
- Make the consensus need a whole-book alignment of each member. It does not: the consensus is built from the members' text and aligned once; each member only needs its probe.
- Read the edition being read from the device's choice. The server does not know it; a place in the edition is what it knows, and that is counted.
