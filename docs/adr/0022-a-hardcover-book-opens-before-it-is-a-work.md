# A Hardcover book opens before it is a work on the server

**Status (2026-11-19).** Discover no longer searches Hardcover (#721): it finds AudiobookDB and Open Library books, which open under `work-abdb-<id>` and `work-ol-<id>` by this record's rule (no write on a look, one address per book, one shape). An address `work-hc-<id>` from an older build opens the work stored as matched to that Hardcover book, and Hardcover is never asked.

Discover finds books on the server and on Hardcover (plan 0.1), and every result opens its Book page at `#book/<workId>` (ADR 0020). A book found on Hardcover that no work on the server is matched to has no work id yet. It opens under the id the Hardcover import already gives such a work, `work-hc-<Hardcover book id>`, and the one-work read answers it from Hardcover's catalogue, not in the library, without writing anything. The work is made the first time someone adds it to their library or gets a file for it, by the import that exists today. A Hardcover book that is matched to a work on the server opens that work.

- **No write on a look.** Browsing Discover makes nothing on the server; a look at a book nobody adds leaves nothing behind in the shared catalogue, in `GET /api/books` or in another user's Discover.
- **One address per book.** The address a result opens is the address the book keeps after it is added, unless the administrator's add matches it to a work that already exists, when the page moves to that work's address (the add answers the work id).
- **One shape.** `GET /api/works/<workId>` keeps the `LibraryWork` shape for these books: not in the library, no recordings, no ebook editions, the Hardcover block with its series, so the Book page needs no second model.

## Considered options

- **Make the work when a result is tapped** (`POST` before opening). Refused: every look writes a work and a placeholder that nobody asked for, and someone who is not the administrator could not see the placeholder they made (`hiddenHardcoverPlaceholders`).
- **An address of its own for a Hardcover book** (`#hardcover/<id>`). Refused: two addresses for one book, a second page model, and #455's address list has no such entry.
- **A result that adds the book at once**, as today's "Add to library" button on each Hardcover result. Refused: the plan says a result opens its Book page with Add to library, so the owner can read about it first.

## Consequences

- The one-work read answers an id of the form `work-hc-<n>` that has no row when that user has Hardcover connected; otherwise, or when Hardcover does not know the book, it answers 404 as for any unknown work.
- Writes that name such an id (Add to library, and Get, which adds the book first) make the work through today's Hardcover import first. The add answers `workId`, and the page replaces its address when it differs.
- A Series page member that is not in the library can open its Book page the same way (the question left open by the Series spec).
- An address like this may sit in a bookmark or the history after the book was matched elsewhere; it then opens the work it was matched to.
