# Keep on this device is a standing choice, one per work and device

Saving for offline use was separate one-time actions in different places (the recording on the book, the ebook in the reader, the alignment map cached as a side effect), and none of them followed a file that changed. It becomes one switch per work on each device, **keep on this device**, which states what the device should hold: the chosen recording, the chosen ebook edition when it is an EPUB, and the alignment map for that pair. The device then makes that true on its own whenever Sonder is open there.

- What arrives later (an ebook, a ready map, another chosen recording) is saved without another tap. An interrupted save resumes by itself, also on mobile data, because a phone's browser cannot tell that from Wi-Fi.
- Nothing is removed without a tap. After a change of recording the earlier recording's copy stays on the device, listed with its size, until the user removes it.
- Turning the switch off asks once, names the total size, and removes every file of that work from the device. The place, the bookmarks and the library entry stay.
- A work is never shown as kept while a file is missing. If the browser cleared files or storage ran out, the switch stays on, the work reads "Not complete" with a retry, and it leaves the On device filter.
- The switch can be on before any file exists. A PDF is never saved by it.

The choice lives on the device and the server does not know it (superseded by ADR 0021: the choice is also recorded on the server for each device). A **device save** is therefore not an **activity** (ADR 0010); Activity lists a device's own saves next to the server's activities from the device's own records.

## Considered options

- **One switch per file.** It lets a phone keep a 1 MB ebook without a 400 MB recording. Refused: the question the screen answers is "does this book work without a connection", and three switches make the user assemble that answer.
- **Keep the one-time actions.** Refused: they do not follow a changed recording, a new ebook or a rebuilt map.

## Consequences

- When this ships, a work whose recording is completely on a device starts with the switch on, so its EPUB and map are saved too. A half-finished save starts with it on and resumes.
- Storage the browser may clear is shown as such (Protected storage), since the choice cannot be honoured by a browser that evicts the files.

## Status (2026-11-16)

Amended by ADR 0021: research on the owner's browsers (#464, #479) showed that an eviction removes the device's own list of kept books together with the files, so the choice is also recorded on the server for each account and device. Everything else here stands.
