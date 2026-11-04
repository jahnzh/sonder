# Worker spec: inspect four weak windows of the whole-book alignment

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
- Why: the owner chose Gemini 3.8 Flash; scripted inspection with a clear spec.

## Task

Your scratch directory: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/ws/weak

The whole-book alignment ran on the WSL host (192.168.1.119) under `~/sonder-replication/ebookset-1793705357/` (the coordinator owns it; add only new files named `weak-*`, never modify others, never touch `~/sonder-replication/issue6-1793194927`; no sudo, no installs, no docker, no production worker).

Facts:
- Results: `results/full.json` on WSL (copy: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/full.json). Keys: samples, chain, windows (each: window, audio [start,end], sent [first,last+1) sentence indices into the reference EPUB's sentence list, n, ok, wall, quality, checks), totalSeconds. Per-window worker output with absolute interval times: `alignment/runs/full-<window>.json` on WSL (field `intervals`: index, start, end; index i = sentence sent[0]+i).
- Run `~/sonder-replication/ebookset-1793705357/venv/bin/python` after `RUN=~/sonder-replication/ebookset-1793705357; source $RUN/repo/scripts/alignment-replication/remote/env.sh`. Audio: `$RUN/audio/ref.mp3`. Reference EPUB and the prototype's poc.py (epub_text(), sentences()) are in `$RUN/win/` (read-only). `$RUN/repo/worker/anchors.py` has transcribe_excerpt(audio, folder, start, duration, language) (folder = $RUN/alignment). The coordinator's pipeline `$RUN/win/wsl_pipeline.py` shows how it is called; read it, do not edit it.
- Weak windows: 59 (audio 36030-36630 s), 64 (39030-39630), 65 (39630-40230), 71 (43230-43830). Their middle-sentence Whisper check scored 0.48, 0.36, 0.0, 0.29 (others scored 0.97 median).

## Proposal

For each of the four windows, transcribe 30 s at the start, middle and end of the window (use the interval times of the sentences found there) and compare with the expected sentences from the EPUB. Classify each window as exactly one of: (a) narration differs from the EPUB text (extra, missing or reordered passage, different wording); (b) alignment error (the text is spoken but timings are off; give the offset in seconds); (c) the check was unreliable (Whisper tiny error, music or effects, unusual names or numbers) while timings are right. Give the evidence: expected text, heard text, ratio. Also state whether neighbouring windows (58, 60, 63, 66, 70, 72) are fine at start and end.

## Constraints

- Read-only except your scratch directory and new `weak-*` files on WSL. No network downloads, no repository edits, no secrets.

## Done when

- REPORT.md in your scratch directory with one section per window: classification, evidence, and the sentence range involved.
- A plain statement of what you could not verify.
