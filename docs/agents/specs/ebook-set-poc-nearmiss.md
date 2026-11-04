# Worker spec: near-miss editions vs the audio anchor check

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
- Why: mechanical, scripted, with a clear spec; the only permitted OpenCode model.

## Task

Your scratch directory: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/ws/nearmiss

Scratch directory and inputs (all absolute):
- Scratch root: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad
- Reference EPUB (same text as the local copy): /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks/libgen-7a72d22ff9b6696e90ad924e42db2d12.epub
- 10 transcribed audio samples of the reference recording: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/samples.json
- Wrong-book EPUBs for contrast: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks/libgen-ebcd23307b828b46fdc09be85f282bec.epub (book 2) and libgen-0f302494247cac7c60b4f20bc899e44f.epub (book 3) in the same folder.

## Proposal

Find where the 0.5 anchor-sample cutoff sits by testing deliberately degraded copies of the reference EPUB. Build each variant as a valid EPUB in your scratch directory (rewrite the XHTML text files inside a copy of the zip; keep the container and OPF intact) and run `python3 -I /home/jahn/audiobook_streamer/scripts/prototype-ebook-set/anchor_check.py /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/samples.json <epub...>` on them together with the reference and the two wrong books. Variants:
1. truncated: keep the first 60% of the text;
2. abridged: delete every 4th paragraph;
3. heavily abridged: delete 3 of every 4 paragraphs;
4. typo noise: in 5% of words swap two adjacent letters;
5. different tokenisation: replace curly quotes and em dashes with ASCII, and join hyphenated words;
6. reordered: swap the first and second halves of the book;
7. translated stand-in: replace 30% of words by a fixed synonym map or by random words from the same book.
Also run `python3 -I /home/jahn/audiobook_streamer/scripts/prototype-ebook-set/poc.py` with the reference first and the variants after it, to get the text shared-sentence fractions.

## Constraints

- Do not edit any prototype script. If a script fails on a variant, report the error and fix your variant instead.
- Keep only what the report needs; delete variants larger than 50 MB.

## Done when

- A table in REPORT.md with one row per variant: samples found out of 10, mean score, forward count, shared-sentence fraction with the reference.
- A plain statement of which variants the current rule (found at least 5 of 10 and forward order) accepts and rejects, and whether any threshold in 0.3 to 0.7 separates good from bad variants.
- Any variant on which the prototype crashed or gave a surprising result, with the exact output.
