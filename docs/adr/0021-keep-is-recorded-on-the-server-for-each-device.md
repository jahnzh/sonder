# Keep on this device is recorded on the server for each device

ADR 0018 made Keep on this device a standing choice per work and device, and kept that choice on the device only. Research on the browsers the owner uses (#464 for an iPhone, #479 for Firefox and Chrome on Android) found that when a browser evicts an origin's storage, or the user clears it, everything goes at once: the files and the device's own list of kept books. A device that had been the only one to remember the choice would forget it had been asked to keep anything, and could neither show "Not complete" nor save the books again. So the choice is also recorded on the server, for each account and device (#465).

- The server gives each browser a device cookie: a random id, HttpOnly, `SameSite=Strict`, 400 days, renewed on every read. Cookies are not quota storage, so an eviction leaves it; clearing "Cookies and site data" removes it with the session, and the browser is then a new device that holds nothing.
- Each choice is a row of the existing per-user settings (`keep:<device id>:<work id>`, with on or off, when, and when this device last completed it). Off is kept as a record, so "turned off" and "never known" differ. No table changes.
- The device keeps its own copy of its choices to work without a connection. A change made offline is sent later; the newer of the two wins, as with places.
- When the server says a device completed a work and the device holds nothing of it, the browser cleared it: the device says so once and saves the kept books again by itself.

The device still does the saving and the server still does not see it, so a **device save** is still not an **activity** (ADR 0010). What ADR 0018 says about what Keep covers, when it saves, what Off removes and that a work is never shown as kept while a file is missing is unchanged.

## Considered options

- **The device remembers alone** (ADR 0018 as written). Refused: an eviction erases the memory together with the files.
- **The list in a cookie the server sets.** Refused: about 60 books fit in 4 KB, and the list would travel with every request.
- **The device id in `localStorage`, as reading checkpoints have it.** Refused: an eviction removes it with everything else, so the server could not tell the device again.

## Consequences

- `GET /api/device/keep`, `PUT` and `DELETE /api/works/<workId>/keep` are new routes; nothing else changes shape.
- Removing a work from the library turns Keep off for it on every device of the account; each device removes the files at its next check.
- Records of a device not seen for 400 days are dropped.
- On a browser shared by two accounts the files stay shared and each account has its own choice; turning Keep off in one removes the files, and the other's next check saves them again.
