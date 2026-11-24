# Nothing is drawn over the book's text

The reader's bars, sheets and notes used to lie over the text and come and go, so a tap for the controls hid the lines being read. The reader's page is now three bands that keep their height whether the controls show or not: a head (44), the text, and a foot (72), plus the safe areas of a phone. Everything the reader shows besides the book goes into the head or the foot, or is a page of its own. The owner asked for exactly this rule on 2026-11-16; the cost, accepted, is 116 px of a phone's height that the text never gets.

- **Controls** appear in the head and the foot on a tap on the text and stay until the next tap. No timer hides them, because they cover nothing. At rest the foot keeps the progress line, the time left and Pause.
- **Something used while reading and that changes the layout** (Appearance, with the reading mode as its first row) docks under the text, and the text is laid out again in what is left, keeping the narrated sentence in view.
- **Something used for a moment** (speed, the sleep timer) takes the place of the foot's transport row, with Done to go back. The text is neither covered nor laid out again. *Superseded on 2026-11-24 by the amendment "a setting's pop-up" (#890), below.*
- **Something that leads elsewhere** (Chapters, Bookmarks, Search) is a page.
- **Every message while reading** appears in the foot: Undo after Listen from here, an error, another session saved a different place, an update is ready, a confirmation. No toast, dialog or sheet opens over the text.

The rule is about the book's text. Elsewhere in the app tooltips, sheets and dialogs open over rows as usual.

## Considered options

- **Bars over the text that hide after a few seconds** (the reader before this). Refused: the text under them is unreadable while they show, and the page jumps if they push it instead.

## Consequences

- The epub.js view is sized once to the text band and not again on a tap.
- A browser test asserts the rule itself: in every state the boxes of the head, the foot and any docked panel do not intersect the box of the text.

## Amendment, 2026-11-23: the text position rail (#804)

The new reading view (ADR 0025) has a text position rail: the book's chapters as a thin column, a thumb for the place in view and a narration mark for the narrated sentence's place. It stands in the text band's right margin over the band's whole height, and unlike the controls it is always there, shown or not.

- **The rule is about what is drawn.** Every box the rail draws, with its ring or halo, lies in the band's right margin and over no line of the book. The box a finger can take around the thumb (44 by 44) reaches over the line ends beside it; it draws nothing, and on touch it takes only a drag up or down: a tap there is the text's tap.
- **The margin rule.** The text's right margin in the new view is never narrower than the rail's column, 24 px, whatever Appearance's Margin is; the left margin stays as set. The rail is in place from the moment the book opens, so showing it lays nothing out again. The band shows no scrollbar of the browser's, which would show the place among the loaded parts rather than in the book.
- The browser test of the rule includes the rail: at rest, away from the narration, held and zoomed, its drawn boxes lie inside the text band and intersect no box of the text.

## Amendment, 2026-11-24: a setting's pop-up, and the notice that leaves the controls in place (#890)

In use the bullet "something used for a moment" cost too much: one tap on Speed took every other control away until Done, and a notice with Undo did the same for 8 seconds. The owner asked for a pop-up above the button and for the Undo not to block the rest of the controls.

> **Amendment: a setting's pop-up.** Speed and the sleep timer open as a pop-up above their button in the foot; the transport row stays. It is the one thing drawn over the book's text, and only so: the reader's tap on its button opens it and nothing else does; it reaches at most 120 px into the text band; the page is not dimmed and the text is not laid out again; a tap outside it, Escape, its button again or the controls hiding closes it. No message appears this way.

- **The notice with Undo stays in the foot, in the status line's place.** "Listening from here" and "Bookmark removed" no longer take the transport row: on a phone with the controls shown the notice takes the timeline's row (the scrubber and its times) for its 8 seconds, and at rest the lower row where the place and the time left stand, with Undo directly after the sentence. The skip buttons, Play or Pause, the sleep timer and Speed stay. Undo's target is 44 high and reaches over the text band's last line, drawing nothing there, as the rail's grip does. So the rule's "every message while reading appears in the foot" still holds. The foot's other messages keep the row's place.
- A tap on the text while a pop-up is open only closes it: a layer over the text band that draws nothing takes that tap, so it does not also show or hide the controls, turn a page, follow a link or start Listen from here.
- The browser test of the rule allows the pop-up and nothing else: with a setting's pop-up open, one pop-up standing on the text band's lower edge and reaching at most 120 px into it, and at every other point of the band the text or the layer that draws nothing; with none open the test is as strict as before.
