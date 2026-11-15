# One following module for the reader

Whether the reader is **following** the narration or **paged away** is decided by one module with no React and no epub.js in it. The reader components send it events (the narration reached a sentence, the view relocated, the reader made a gesture, opened Contents, turned a page, stepped a word, resized, a layout started or ended, back to narration) and render what it answers: following or not, and whether a jump to the narrated sentence should run and under which epoch. The epochs, the time windows and the rules for which input wins live there and nowhere else.

**Back to narration is one operation.** Every way of asking for it runs the same steps: drop a manual position that is waiting to be saved, start following, forget the last followed sentence so the next narration update moves the view even to the same sentence, reset the retry count, and clear a follow error that is shown. The entry points are the player-bar button, the `F` key, Read from audio, Listen from here and its Undo, the scrubber, a seek in Lyrics mode, and switching on "Follow the narration". On 2026-11-14 these were eight hand-written copies that differed in which steps they ran; the copy on the `F` key and the Lyrics seek did not drop the waiting manual position, which lets it overwrite the listening place a moment later. The differences were accidents, not intended behaviour.

Page mode, Lyrics mode and Word mode share one following state. A word step in Word mode is an event like a page turn: it pages away and invalidates a jump that is in flight.

The four time windows (500 ms, 1000 ms, 1500 ms and 10 s) are tolerances for epub.js reporting a relocation after the cause. They become named constants with a sentence each on what they wait for. Their values do not change in this work; changing one is a separate change with a measurement.

## Considered options

- **Leave the state in `Reader.tsx` and extract only back to narration.** That fixes the copies but leaves the ordering rules testable only through the browser, where the two open flaky tests in this area (#369, #374) live.
- **A following state per mode.** Switching mode would then need rules for carrying the state over, and the reader has one narration to follow.

## Consequences

- Built behaviour-first: unit tests that drive the module with a scripted event sequence pin each ordering rule as it is today, then `Reader.tsx` is moved onto the module. The `integrated-reader`, `reader-frame` and `position-history` browser tests stay unchanged and must pass with repeats.
- The one intended behaviour change is the unified back to narration. It is checked in the deployed UI with real media before the issue closes (CLAUDE.md, Conventions).
- This is a slice of the wider reader sync work in #24 and does not touch the fallback rules of #160.
- Issue: #390.
