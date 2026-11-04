# Worker spec: verify and report the WSL one-window alignment

Repository: Sonder, in `/home/jahn/audiobook_streamer`. This task is a read-only experiment: do NOT edit, add or commit any file in the repository or your worktree. Write everything under your own scratch directory (given below). Read `AGENTS.md` for context only. The prototype under test is in the main checkout at `/home/jahn/audiobook_streamer/scripts/prototype-ebook-set/` (untracked there; read it by absolute path and never modify it). Decisions it tests are in `/home/jahn/audiobook_streamer/docs/adr/0004-shared-confirmed-reading-pair.md`.

Rules:
- Do not push, merge, or open a PR. Do not run `docker compose`. Do not touch `data/`, `artifacts/` or production media, and do not print or copy secrets from `.env`. Exceptions are listed in the task, if any.
- Check every command flag and environment variable with `--help` or grep before you use it.
- Commands that take longer than 90 seconds go in the background with output in a log file that you poll, reading coordinator messages between polls: `orca orchestration check --terminal <your_handle> --json`.
- Python runs as `python3 -I script.py args` (no import from the working directory).
- If you hit a usage limit, stop and say so in your report.

Completion: your report (also saved as `REPORT.md` in your scratch directory) lists every bullet under "Done when", and next to each the command and its real output that shows it. Say plainly what you could not verify. A bullet with no evidence is not done.

## Model choice

- Agent: antigravity
- Model: gemini-3.8-flash-high
- Effort: n/a
- Why: the owner chose Gemini 3.8 Flash (Gemini Models bucket, separate from Claude Code); the task is scripted verification with a clear spec.

## Task

Your scratch directory: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/ws/wslcheck

The alignment already ran on the WSL host (192.168.1.119). Do NOT run another alignment and do not use the production alignment worker, `docker exec`, `sudo` or any package installation. Work on WSL only under `~/sonder-replication/ebookset-1793705357/` (a run directory made for this experiment; the coordinator owns it). Never touch `~/sonder-replication/issue6-1793194927`.

Facts (from the coordinator):
- Run directory on WSL: ~/sonder-replication/ebookset-1793705357/ . Inputs/outputs in `win/`: `window.wav` (900 s slice of the reference recording starting at 1947.72 s into the full audio), `fragments.json` ({"sentences":[{"text":...}]}, 206 normalised sentences starting at sentence index 408 of the reference EPUB), `out.json` (worker result: intervals for the 206 sentences, quality fields; it took 3.8 s, excerpt match score 0.951). Log: `logs/align.log`.
- Python with the worker's dependencies, including faster-whisper and the cached tiny model: `~/sonder-replication/ebookset-1793705357/venv/bin/python`; to use it, source `~/sonder-replication/ebookset-1793705357/repo/scripts/alignment-replication/remote/env.sh` with RUN set to the run directory first. Read `repo/scripts/alignment-replication/remote/align_chapter.py` and `repo/worker/align.py` to learn the shape of out.json. Check every field name against a real sample of out.json before using it.
- Local files (reference EPUB, prototype scripts): /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks/libgen-7a72d22ff9b6696e90ad924e42db2d12.epub and /home/jahn/audiobook_streamer/scripts/prototype-ebook-set/ (poc.py has epub_text(), sentences(), shared(); do not edit these files). An identical second copy of the book: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks/libgen-d8a811082e5f3a14232f459a21f1689f.epub. A different edition-like contrast copy: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks/libgen-ebcd23307b828b46fdc09be85f282bec.epub (book 2).

## Proposal

1. Copy out.json and the logs to your scratch directory. Describe its fields and check the intervals: count, monotonic order, gaps and overlaps, first and last times against the 900 s window, and the quality fields.
2. Spot-check 5 sentences spread over the window (for example sentences 10, 50, 100, 150, 200): for each, cut the audio from its reported start to end (plus 1 s each side) from `win/window.wav` on the WSL host with Whisper tiny, then compare the transcript with the sentence text using a word-level ratio. Report time, expected text, heard text, ratio.
3. Check the end of the window: transcribe the last 30 s of window.wav and find which fragment it matches, to see whether the 206 fragments overshoot or undershoot the audio.
4. Project the timings onto the second identical copy: align its sentences to the reference EPUB's with difflib (as poc.py's shared()) and report the share of its 206-window-equivalent sentences that receive an exact timing. Do the same for the contrast book and report the share (expected near zero).
5. Write REPORT.md with what held, what did not, and numbers.

## Constraints

- Read-only except under your scratch directory and under `~/sonder-replication/ebookset-1793705357/` on WSL (new files only, name them with a `check-` prefix; never modify win/, logs/, results of the coordinator, venv/ or repo/).
- No network downloads, no installs. No repository edits. Do not print secrets.

## Done when

- REPORT.md in your scratch directory answers items 1 to 5 with real command output.
- A plain statement of what you could not verify.
