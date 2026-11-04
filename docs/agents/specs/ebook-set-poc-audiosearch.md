# Worker spec: audio search with the existing providers (read-only)

Repository: Sonder, in `/home/jahn/audiobook_streamer`. This task is a read-only experiment: do NOT edit, add or commit any file in the repository or your worktree. Write everything under your own scratch directory (given below). Read `AGENTS.md` for context only. The prototype under test is in the main checkout at `/home/jahn/audiobook_streamer/scripts/prototype-ebook-set/` (untracked there; read it by absolute path and never modify it). Decisions it tests are in `/home/jahn/audiobook_streamer/docs/adr/0004-shared-confirmed-reading-pair.md`.

Rules:
- Do not push, merge, or open a PR. Do not run `docker compose`. Do not touch `data/`, `artifacts/` or production media, and do not print or copy secrets from `.env`. Exceptions are listed in the task, if any.
- Check every command flag and environment variable with `--help` or grep before you use it.
- Commands that take longer than 90 seconds go in the background with output in a log file that you poll, reading coordinator messages between polls: `orca orchestration check --terminal <your_handle> --json`.
- Python runs as `python3 -I script.py args` (no import from the working directory).
- If you hit a usage limit, stop and say so in your report.

Completion: your report (also saved as `REPORT.md` in your scratch directory) lists every bullet under "Done when", and next to each the command and its real output that shows it. Say plainly what you could not verify. A bullet with no evidence is not done.

## Model choice

- Agent: opencode
- Model: nris/Qwen3.8-27B
- Effort: n/a (no effect)
- Why: mechanical lookup with a clear spec and a read-only boundary.

## Task

Your scratch directory: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/ws/audiosearch

Scratch directory and inputs (all absolute):
- Scratch root: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad
- Reference EPUB (same text as the local copy): /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks/libgen-7a72d22ff9b6696e90ad924e42db2d12.epub
- 10 transcribed audio samples of the reference recording: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/samples.json
- Wrong-book EPUBs for contrast: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks/libgen-ebcd23307b828b46fdc09be85f282bec.epub (book 2) and libgen-0f302494247cac7c60b4f20bc899e44f.epub (book 3) in the same folder.

## Proposal

Find out which existing audio providers can search for "Dungeon Crawler Carl" (book 1) and what each returns, using the app's own provider code from a scratch environment, never the running app or its database. Use CodeGraph (`codegraph explore "audiobookbay search services prowlarr torbox"`) to find the search functions in `server/services.ts` and the route handlers in `server/app.ts` (/api/discover/abb, /api/discover/prowlarr). Write a throwaway tsx script in your scratch directory that imports the exported search function and runs it with: `REQUIRE_MEDIA_MOUNT=false DATA_DIR=/tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/ws/audiosearch/data MEDIA_ROOT=/tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/ws/audiosearch/media`. The ebook equivalent already exists and works as a pattern: `/home/jahn/audiobook_streamer/scripts/prototype-ebook-set/search.ts` (run from `/home/jahn/audiobook_streamer` with `npx tsx`, so the repo imports resolve).

## Constraints

- SEARCH ONLY. Never call any function or route that adds, acquires, downloads, queues or caches a torrent or magnet, or that writes to TorBox, Transmission, Prowlarr or the production database. This includes TorBox cache checks that need an account key.
- A provider that needs credentials from the production database (Prowlarr, TorBox) is not searchable from the scratch environment. Do not read credentials; report it as "needs credentials" and stop.
- Do not open the production database `/home/jahn/audiobook_streamer/data/sonder.db`.

## Done when

- A list of the providers found in the code, with for each: the function, whether it ran in the scratch environment, and the result or the reason it could not run.
- For each provider that ran: the top 10 results (title, narrator or author if present, size, any identifier) for the query, and which of them look like book 1 of Dungeon Crawler Carl narrated by Jeff Hays and which are other books in the series.
- A plain statement of whether an audio result could be tied to the local reference recording (torrent id 128609707 / TorBox) and how, without downloading anything.
