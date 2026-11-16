# One reading view in two modes

The reader shows the book's own text and nothing else, as turnable pages (**pages mode**) or as one moving column (**scroll mode**). The Lyrics and Word views are removed with their settings (the view choice, words per line, words per minute), at the owner's request on 2026-11-16 ("Keep only the pages reading mode. I want to switch between pages mode and scroll mode."). Each removed view added its own events, pending saves and browser tests to the one following module (ADR 0014 lists them).

What goes with them, and is accepted: starting the audio by tapping a line (long-pressing a sentence, **Listen from here**, stays), reading at a set number of words per minute, stepping word by word, and the `P` key. "Correct this sentence's timing" leaves the interface as well, because an alignment map is never corrected by hand (`GLOSSARY.md`); its endpoint stays for older open clients.

## Consequences

- The word-time interpolation the Word view used (`src/word-timing.ts`) stays. The reader needs it to turn the page inside a sentence that crosses two pages. That moment is an estimate from the sentence's start and end, about a second early or late; no per-word timing is added to the alignment map for it.
- The saved appearance fields `reader.display`, `segmentWords` and `wordWpm` stay accepted and are ignored, because an older open client still sends them.
- ADR 0014's one following module stays as decided. Its mentions of Lyrics mode and Word mode stop applying once the views are gone.
- The code remains in git history; bringing a view back means rebuilding its following rules against the module of ADR 0014.
