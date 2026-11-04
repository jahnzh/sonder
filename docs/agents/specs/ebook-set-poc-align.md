# Worker spec: one-section alignment through the worker

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
- Why: scripted steps against a fixed HTTP API; the coordinator set tight limits below. Do not widen them.

## Task

Your scratch directory: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/ws/align

Scratch directory and inputs (all absolute):
- Scratch root: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad
- Reference EPUB (same text as the local copy): /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks/libgen-7a72d22ff9b6696e90ad924e42db2d12.epub
- 10 transcribed audio samples of the reference recording: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/samples.json
- Wrong-book EPUBs for contrast: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks/libgen-ebcd23307b828b46fdc09be85f282bec.epub (book 2) and libgen-0f302494247cac7c60b4f20bc899e44f.epub (book 3) in the same folder.
- Local reference audio (13.5 h MP3): /mnt/usb_4t_1/sonder/saved/1842564c311cb326118631496d93a1d7f99e8b8fef11f81dd36fb67d47795623.mp3 (48693 s)
- Worker: http://127.0.0.1:3012 (read worker/align.py for the /align and /anchor request shape; read README.md "Prepare reading sync" for the windowing method).

## Proposal

Run ONE known-text alignment window, the way the README describes it, and measure it:
1. From samples.json (sample i starts at `start` seconds), find where samples 0 and 1 sit in the reference EPUB (sentence index in the list that `poc.py`'s `sentences()` produces; reuse the matching in `anchor_check.py`).
2. Align audio window [start0, start1] (about 4860 s) against the sentences between those two positions, by one POST to `/align` with `audio` = the MP3 path above, `output` = `/mnt/usb_4t_1/sonder/alignment/prototype-ebook-set/window0.json`, `fragments`, `start`, `duration`. The token is the value of `ALIGNMENT_WORKER_TOKEN` in `/home/jahn/audiobook_streamer/.env`: read that single variable into a shell variable with grep/cut, send it in the request, and never print, log or write it anywhere.
3. Check the result: how many sentences were given timings, the order of timings, the elapsed wall time, and spot-check 5 sentences by transcribing the audio at their reported time with the cached Whisper tiny model (see `/home/jahn/audiobook_streamer/scripts/prototype-ebook-set/sample_audio.py`, run in the container as in its header) and comparing text.
4. Project the timings onto one other identical copy (`libgen-d8a811082e5f3a14232f459a21f1689f.epub`) by text alignment (`difflib`, as in poc.py) and report the share of its sentences that received an exact timing.

## Constraints

- Production safety (these override the rules block where they differ):
  - First `curl -s localhost:3012/health`. Start only if `busy` is false and `stuck` is false. If busy, wait and recheck every 2 minutes for up to 20 minutes, then report "worker busy" and stop.
  - Make exactly ONE /align request, window of at most 4900 s. If it returns 409, 504 or an error, do not retry; report the status and body.
  - The only production path you may write is `/mnt/usb_4t_1/sonder/alignment/prototype-ebook-set/` (create it; the worker may need the directory to exist and be writable by uid 1000). Copy window0.json to your scratch directory and then delete that production directory.
  - Do not call the app's API or touch `data/`. Read-only use of the .env token as described above is the only .env access.
- Do not modify prototype scripts.

## Done when

- The /health output before and after, the request parameters (without the token), the HTTP status, elapsed seconds, and the number of fragments sent versus timed.
- A table of the 5 spot-checks: reported time, expected sentence, what was heard, match ratio.
- The projection share for the second copy.
- Confirmation that the production `prototype-ebook-set` directory was deleted (output of `ls`).
