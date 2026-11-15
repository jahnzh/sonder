# The delivery source for a play is chosen in one page module

One module in the page decides the **delivery source** for a play (device copy, server copy, original stream) and what to switch to when the chosen one fails. It is a pure function of what the page knows: the reader's stored choice for the recording, the fault flags, whether a complete device download exists, whether the device is online, whether the server failed a moment ago, and which sources the track has. It returns a plan: the source to try first, the ordered fallbacks, and the source to show in the player. Loading a track, recovering from a stall and the source indicator all follow the plan and no longer decide for themselves.

The service worker keeps one decision of its own, and its contract is frozen because older client builds that are still open rely on it:

- A media request with `source=server` or `source=original` goes to the network unchanged.
- A request with no `source`, or `source=auto`, is answered from a complete device download when there is one, otherwise from the network, falling back to a cached segment when the network fails.
- The service worker reports the source it used (`X-Sonder-Media-Source` and its message to the page).

The page module expresses its plan through that `source` parameter. Nothing new is added to the service worker for this.

The rule for conflicting progress writes (the newer position wins) is not part of this decision. It is applied in the player, in the local store and on the server, and belongs to the progress write rules (candidate 3 in `docs/ARCHITECTURE_REVIEW.md`).

## Considered options

- **Move the whole decision into the service worker.** It sees every request, but it cannot know about a stall, and a new service worker reaches a device only after the old one is replaced, so two rule sets would be live at once.
- **Leave it.** The choice is made in `playbackInput`, again in `load`, again in `recoverOnDevice` and again in the service worker; the source shown in the player is set in four places.

## Consequences

- Lowest priority of the 2026-11-14 candidates (the review called it speculative). It is built after ADR 0014.
- Unit tests cover the choice and the fallback order for every combination the plan distinguishes. The `stalled-seek`, `offline-restart` and `source-progress` browser tests stay unchanged.
- Offline playback is checked on a real device before the issue closes; the browser tests cannot show a phone restart.
- Issue: #396.
