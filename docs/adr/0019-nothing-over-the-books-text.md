# Nothing is drawn over the book's text

The reader's bars, sheets and notes used to lie over the text and come and go, so a tap for the controls hid the lines being read. The reader's page is now three bands that keep their height whether the controls show or not: a head (44), the text, and a foot (72), plus the safe areas of a phone. Everything the reader shows besides the book goes into the head or the foot, or is a page of its own. The owner asked for exactly this rule on 2026-11-16; the cost, accepted, is 116 px of a phone's height that the text never gets.

- **Controls** appear in the head and the foot on a tap on the text and stay until the next tap. No timer hides them, because they cover nothing. At rest the foot keeps the progress line, the time left and Pause.
- **Something used while reading and that changes the layout** (Appearance, with the reading mode as its first row) docks under the text, and the text is laid out again in what is left, keeping the narrated sentence in view.
- **Something used for a moment** (speed, the sleep timer) takes the place of the foot's transport row, with Done to go back. The text is neither covered nor laid out again.
- **Something that leads elsewhere** (Chapters, Bookmarks, Search) is a page.
- **Every message while reading** appears in the foot: Undo after Listen from here, an error, another session saved a different place, an update is ready, a confirmation. No toast, dialog or sheet opens over the text.

The rule is about the book's text. Elsewhere in the app tooltips, sheets and dialogs open over rows as usual.

## Considered options

- **Bars over the text that hide after a few seconds** (the reader before this). Refused: the text under them is unreadable while they show, and the page jumps if they push it instead.

## Consequences

- The epub.js view is sized once to the text band and not again on a tap.
- A browser test asserts the rule itself: in every state the boxes of the head, the foot and any docked panel do not intersect the box of the text.
