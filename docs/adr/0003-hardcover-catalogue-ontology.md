# Adapt Hardcover's catalogue ontology and reuse its metadata

**Status (2026-11-19).** Hardcover is gone (#721): the catalogue is AudiobookDB for audiobooks and Open Library for books without one, linked per work (and per recording to a release) on the book's Match page and shown by URL, never stored; a field is overridden and reverted on the book's Edit page (#719). The work, edition and recording split described here stands.

Sonder adapts Hardcover's book, edition and series model and reuses its catalogue metadata, rather than independently defining these relationships. Sonder's Work corresponds conceptually to a Hardcover Book; published edition metadata remains distinct from a particular recording or downloaded ebook file. Preserving Hardcover identities and membership relationships avoids a parallel catalogue that drifts from the provider, while Sonder adds its acquisition, storage, alignment and personal library state.

Hardcover metadata is mirrored by default, with explicit manual overrides allowed locally. Imported audio and ebooks remain usable with basic file metadata when their Hardcover identity is unknown and can be linked later; uncertain matches require confirmation. Sonder retains the last fetched metadata when Hardcover is unavailable, and missing or failed responses do not remove library entries or files.

Overrides apply only to explicitly edited fields or relationships; everything else continues to refresh from Hardcover. Users can restore a field or relationship from Hardcover to clear its override.

Hardcover's [edition schema](https://github.com/hardcoverapp/hardcover-docs/blob/main/src/content/docs/api/GraphQL/Schemas/Editions.mdx) defines the book/edition distinction, and its [series membership schema](https://github.com/hardcoverapp/hardcover-docs/blob/main/src/content/docs/api/GraphQL/Schemas/BookSeries.mdx) defines positions, textual details and compilation membership. The [series standards](https://github.com/hardcoverapp/hardcover-docs/blob/main/src/content/docs/librarians/Standards/SeriesStandards.mdx) explain why names alone cannot identify a series.

**Amendment (2026-11-05).** Non-admin listeners may not select a series catalogue work that would link their unlinked owned book to a shared Hardcover identity. That link changes catalogue state only administrators may edit; the saved series preview keeps the existing block and `needsAdmin` explanation rather than allowing silent linking. This matches coordinator decision **C5** in `artifacts/orca/DECISIONS-2026-11-04.md` (#210 item 4).
