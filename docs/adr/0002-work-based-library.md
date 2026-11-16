# Work-based libraries and a shared series catalogue

A user's library contains works, each grouping its audio and ebook editions, including ebook-only works; series membership and ordering belong to the shared catalogue. This replaces audio-edition-based library membership so adding another format or managing a series does not create duplicate titles. Library membership and progress remain personal, and listening and reading positions remain separate for each recording and ebook edition.

Finishing any recording or ebook edition counts as finishing the work for that user, and a work counts once toward series completion. Users can explicitly override finished/unread status; listening and reading percentages are not combined, and the separate checkpoints remain intact.

## Status (2026-11-16)

Built in what the user sees and in the per-user records keyed by work (completion, library origin, media state). Not built in library membership itself: `user_library` and `user_hidden_library` still point at an audio edition, and a work without audio is in a library through a placeholder audio edition (ids starting `hc-`), which real audio later replaces.

The interface redesign of November 2026 keeps that on purpose. An ebook-only work gets a placeholder the same way, the client reads and addresses books by work, and no table changes, so that an interface effort carries no data migration. Moving membership onto works is a separate effort.

