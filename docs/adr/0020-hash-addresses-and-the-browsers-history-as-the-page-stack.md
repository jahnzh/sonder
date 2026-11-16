# Hash addresses, and the browser's history as the page stack

The redesign turns dialogs into pages (`#book/<workId>/audiobook`, `#series/<id>`), so the app needs addresses with parameters and a rule for Back. Addresses stay behind the `#`, the page stack is the browser's own history, and one small module of our own reads and writes addresses; no router library is added.

- **Behind the `#`**, because the server, Caddy and the service worker then keep serving one document as today. A path per page would need a fallback in all three. `/join` stays the only real path.
- **The browser's history is the stack**, because Back then means the same for the phone's gesture, Android's Back and the browser's button, and a reload keeps it. Opening a page adds one entry, and so do switching place, a full-screen sheet and Now playing, so Back closes them. Switching between Activity's parts or between Listen and Read replaces the entry, as does a redirect. Tooltips, pickers and confirmations are not entries.
- **A page's own back button goes where the user came from**, and to the page's parent when no entry of the app lies behind it (opened by a link, or the first page after a launch).
- **No library**, because the rules above are this app's own and about twenty address shapes do not need one.

The installed app starts on the Library, not on the last page (the owner, 2026-11-16). Old addresses (`#downloads`, `#reader/<ebook id>`) keep working for good, because a home-screen icon or a bookmark may hold one.

## Considered options

- **Path addresses** (`/book/…`). Refused for the three fallbacks above, with no gain for an installed app.
- **A router library.** Refused: it brings its own model of history, and the rules for sheets, places and the back button would still be ours to write.
- **A stack kept in memory beside the history.** Refused: two answers to "what is behind this page" drift apart on a reload.

## Consequences

- The reader used to move the address forward when it closed, so Back reopened it. Closing now goes back.
- The phone's back gesture closes Now playing. In pages mode a swipe from the very left edge of an iPhone goes back instead of turning the page, as the reader did before; tapping the edge turns the page.
- The address list and the rest of the answer: issue #455, "How pages stack and what Back does".
