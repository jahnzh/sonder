# Worker spec: HANDOFF - fetch the whole Dungeon Crawler Carl audiobook series and run the pipeline on it

Repository: Sonder, in `/home/jahn/audiobook_streamer`. This task is an experiment, not a repository change: do NOT edit, add or commit any file in the repository or your worktree except as the task allows. Write everything else under your own scratch directory (given below). Read `AGENTS.md` for context only. The prototype under test is in the main checkout at `/home/jahn/audiobook_streamer/scripts/prototype-ebook-set/` (untracked there; read it by absolute path and never modify it). Decisions it tests are in `/home/jahn/audiobook_streamer/docs/adr/0004-shared-confirmed-reading-pair.md`.

Rules:
- Do not push, merge, or open a PR. Do not run `docker compose`. Do not touch `data/`, `artifacts/` or production media, and do not print or copy secrets from `.env`. Exceptions are listed in the task, if any.
- Check every command flag and environment variable with `--help` or grep before you use it.
- Commands that take longer than 90 seconds go in the background with output in a log file that you poll, reading coordinator messages between polls: `orca orchestration check --terminal <your_handle> --json`.
- Python runs as `python3 -I script.py args` (no import from the working directory).
- If you hit a usage limit, stop and say so in your report.

Completion: your report (also saved as `REPORT.md` in your scratch directory) lists every bullet under "Done when", and next to each the command and its real output that shows it. Say plainly what you could not verify. A bullet with no evidence is not done.

## Model choice

- Agent: cursor
- Model: composer-2.5
- Effort: n/a
- Why: scripted work with a clear spec; Cursor Models bucket (free), chosen because the coordinator's own token budget is nearly used up and the owner asked for a handover.

## Handover: where things stand (coordinator = Claude Code session, run run_e8375a61a177)

Goal (owner's words): "Improve search and sources until the entire series of audiobooks can be fetched", then run the ebook/audio matching pipeline on the series. The owner does not want to over-fit to one book.

Everything so far is documented in /home/jahn/audiobook_streamer/docs/adr/0004-shared-confirmed-reading-pair.md (read it first; it is untracked, do not commit it) and the prototype scripts in /home/jahn/audiobook_streamer/scripts/prototype-ebook-set/ (untracked; read them, you may ADD new scripts there, name them with a fetch- prefix, never edit existing ones without saying so in the report).

Done:
- Series = 9 volumes from Hardcover (series.ts / series-run.ts). Ebooks: top-5 per volume downloaded, 23 files, 8 content clusters, labels all consistent. Scratch media dir: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media/ebooks, manifest /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/series/manifest.json, one representative EPUB per volume on the coordinator side in /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/rep/vol1..vol8.epub (also copied to the WSL run directory as win/vol1..vol8.epub).
- Audio probe + alignment pipeline works on WSL (192.168.1.119, run directory ~/sonder-replication/ebookset-1793705357/): win/wsl_matrix.py (audio x ebook anchor-score matrix, parallel) and win/wsl_pipeline.py (windowed alignment; run with MIN_WORDS=1). Verified on volumes 1 and 2 (their audio is a local copy; 12/12 samples match only their own volume; alignment covers 98%). To run them: cd ~/sonder-replication/ebookset-1793705357 && RUN=$PWD && source repo/scripts/alignment-replication/remote/env.sh && nice -n 10 $RUN/venv/bin/python -I win/wsl_matrix.py $RUN 12 <audio...> -- <epubs...>   and   MIN_WORDS=1 nice -n 10 $RUN/venv/bin/python -I win/wsl_pipeline.py $RUN win/volN.epub <audio> 600 0 <prefix>   (read both scripts' headers).
- Improved audio source search (series-audio.ts, read-only): pagination, query variants, compilation/episode filters, hash resolution, one batched TorBox cache check. Result in /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/series/audio-candidates.json: volumes 1,2,3,4,6,7,8 each have exactly one plain candidate, all CACHED on TorBox (hashes are in chosen[]). Volumes 5 and 9 found NOTHING in this run.

Open problems for you:
1. Volume 5 (The Butcher's Masquerade): an earlier, simpler run found 3 AudioBookBay results (title uses a curly apostrophe: "The Butcher’s Masquerade", 1.25 GB M4B/M4A) and series-audio.ts found none, probably because AudioBookBay requests failed (the code swallows errors with .catch(() => null)) or the Prowlarr title has no apostrophe ("Butchers Masquerade"). Find out why, fix the search (retry with backoff, log errors, normalise apostrophes, try title variants), and get a hash + TorBox cache status. Volume 9 (The Beautiful Place): check whether it is released at all (Hardcover lists a null year); if not, say so and skip it.
2. Fetch the audio of volumes 3,4,5,6,7,8 (1 and 2 already exist locally; fetching them too, to compare against the local copies, is optional): TorBox only, through the cached route the app uses (POST torrents/createtorrent with add_only_if_cached=true, allow_zip=false; see /home/jahn/audiobook_streamer/server/acquisitions.ts lines 131-160 and torbox()/torboxUrl() in server/services.ts). Credentials: the tsx scripts read them from a COPY of the production database; run them exactly as the earlier ones: cd /home/jahn/audiobook_streamer && REQUIRE_MEDIA_MOUNT=false DATA_DIR=/tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/proddata MEDIA_ROOT=/tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/media npx tsx scripts/prototype-ebook-set/<script>.ts ... . Never print a token, key or signed download URL into a log, report or file you keep; keep download URLs in memory or in a mode-600 temp file that you delete.
3. Download the audio files DIRECTLY ON THE WSL HOST into ~/sonder-replication/ebookset-1793705357/audio/ (volN.<ext>, one file per volume; if a torrent has several files, keep them in ~/sonder-replication/ebookset-1793705357/audio/volN/ and say how you combined them). WSL has 826 GB free; the local server disk has under 20 GB free, so never download audio to the local machine and never into production media or the production library.
4. For each fetched volume run win/wsl_matrix.py against all 8 cluster EPUBs (the diagonal must match: the right volume 12/12 samples, others 0) and then win/wsl_pipeline.py with MIN_WORDS=1 on the matching EPUB (win/volN.epub). Run volumes in PARALLEL where the 16-core WSL host allows (nice -n 10; at most 3 alignments at once). Collect one table: per volume, source title and size, cache status, matrix diagonal result, anchors kept, windows ok, sentences covered, median mid/last Whisper check ratio.
5. Append a short section "Fetched series" to /home/jahn/audiobook_streamer/docs/adr/0004-shared-confirmed-reading-pair.md with that table and what went wrong.

## Constraints and safety floor (these override anything above)

- TorBox ONLY, and ONLY cached torrents (add_only_if_cached=true). Do NOT add anything to the local Transmission / VPN container (sonder-torrents, transmission-openvpn), and do NOT use the app's acquire() or any route that writes to the production library or database. If a volume has no cached source, stop for that volume and report it; do not fall back to local torrents without asking the coordinator (use the orca ask command in your preamble).
- Keep a ledger file /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/ws/fetch/torbox-ledger.json with every TorBox torrent id and hash you add, so the owner can delete them. Do not delete or modify any other torrent in the TorBox account.
- No production worker, no docker exec writes, no sudo, no package installation, no network downloads other than TorBox links, search providers and Hardcover. Work on WSL only under ~/sonder-replication/ebookset-1793705357/ (new files only; never touch ~/sonder-replication/issue6-1793194927). Do not run docker compose.
- When finished, DELETE the credential copy: rm -rf /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/proddata (it holds a copy of the production database and the encryption key), and say so in the report. Delete large intermediate files you created on the coordinator side; leave the WSL audio and results in place and list their paths so the owner can remove the run directory.
- Your scratch directory: /tmp/claude-1000/-home-jahn-audiobook-streamer/46634817-5d47-47c9-8216-91feec7223dc/scratchpad/ws/fetch (create it).
- Use CodeGraph (codegraph explore) to read repository code.

## Done when

- A table for volumes 1 to 9 as described in step 4, with "not available" and the reason where a volume could not be fetched.
- The ledger of TorBox torrents added.
- The ADR section written; proddata deleted; plain statement of anything unverified or left undone.
