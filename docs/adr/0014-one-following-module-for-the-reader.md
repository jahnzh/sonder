# One following module for the reader

Whether the reader is **following** the narration or **paged away** is decided by one module with no React and no epub.js in it. The reader components send it events (the narration reached a sentence, the view relocated, the reader made a gesture, opened Contents, turned a page, stepped a word, resized, a layout started or ended, back to narration) and render what it answers: following or not, and whether a jump to the narrated sentence should run and under which epoch. The epochs, the time windows and the rules for which input wins live there and nowhere else.

**Back to narration is one operation, with one rule.** Every way of asking for it (the player-bar button, the `F` key, Read from audio, Listen from here and its Undo, the scrubber, a seek in Lyrics mode, switching on "Follow the narration") runs the same steps. It drops a waiting manual position only when there is a narration to follow: a map for the open ebook that matches the recording in the player, with a current interval. It then drops every pending save of a place the reader chose by hand, wherever that save is waiting (the page debounce, Word mode's checkpoints, a Lyrics turn, a search result, the scrubber), starts following, forgets the last followed sentence, resets the retry count and clears a follow error that is shown. Without a narration to follow, a waiting manual position is left alone and still gets saved. A relocation reported late by a navigation that started before the return is not a manual move.

This rule replaces the first version of this decision, which dropped the waiting position unconditionally. Two reviewed attempts showed why: with no narration to follow that loses the reader's only saved place, and a pending save can wait in several independent places, so the operation needs one owner for all of them. On 2026-11-14 the entry points were eight hand-written copies that differed in which steps they ran. **The one operation is not built yet** (#417, which lists the sequences it must get right); the module below is.

Page mode, Lyrics mode and Word mode share one following state. A word step in Word mode is an event like a page turn: it pages away and invalidates a jump that is in flight.

The four time windows (500 ms, 1000 ms, 1500 ms and 10 s) are tolerances for epub.js reporting a relocation after the cause. They become named constants with a sentence each on what they wait for. Their values do not change in this work; changing one is a separate change with a measurement.

## Considered options

- **Leave the state in `Reader.tsx` and extract only back to narration.** That fixes the copies but leaves the ordering rules testable only through the browser, where the two open flaky tests in this area (#369, #374) live.
- **A following state per mode.** Switching mode would then need rules for carrying the state over, and the reader has one narration to follow.

## Consequences

- Built behaviour-first: unit tests that drive the module with a scripted event sequence pin each ordering rule as it is today, then `Reader.tsx` is moved onto the module. The `integrated-reader`, `reader-frame` and `position-history` browser tests stay unchanged and must pass with repeats.
- Built in two parts. First the module and the move of `Reader.tsx` onto it, with no behaviour change (#390). Then the one operation for back to narration (#417), the only intended behaviour change, checked in the deployed UI with real media before that issue closes (CLAUDE.md, Conventions).
- This is a slice of the wider reader sync work in #24 and does not touch the fallback rules of #160.
- Issues: #390, #417.
