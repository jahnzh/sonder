# Handoff: roadmap pass on 2026-10-27

Coordinator session working through GitHub issues #1–#5 (pinned roadmap #11 on `jahnzh/sonder`) with four supervised Orca workers. All workers are halted and released. Per-worker notes: `HANDOFF-fix-ui-alignment.md`, `HANDOFF-single-file-sync.md` (this folder). The torrent diagnosis is `torrent-health-diagnosis.md` (this folder).

## Follow-up later on 2026-10-27

- Deployed `main` (roadmap merges plus the two commits below) and pushed it. Prowlarr is configured in production (8 indexers, test OK, live search works). Torrent health: `ok`, incoming port closed.
- #3 and #4 closed. #1 and #2 have result comments and stay open for the phone and iOS Safari check.
- `9f496ea`: Save to server failed on the 14.6 h "Unknown narrator" DCC M4B with "MP4 table entry count 103009 exceeds entry limit 100000" (music-metadata 12 default). All `parseFile` calls now share `audioParseOptions` (`server/chapters.ts`) with a 10M limit. The copy now succeeds.
- `bfe67f0`: merged `single-file-sync` (#5). The full test run (Jeff Hays DCC, chapters ignored) against the chapter map gave 99.4% text coverage, median 8.5 ms, 99.1% within 1 s and max 3.9 s. Flags: the outro plus unnarrated front and back matter.
- The "Unknown narrator" release is not chapterless. Read from the HDD copy, it has 55 French chapter markers, so it is a French narration (its edition language is empty). Anchored mode correctly refuses it. No truly chapterless release exists in the library to test with.
- "Game of Thrones" is still at 0.11%, 1 peer, 0 KiB/s and has no trackers, so the swarm looks dead.
- Cleanup done: the four worktrees and their branches were removed (all merged), along with `/home/jahn/sonder-worktrees`. The extra Orca repos are no longer listed. Roadmap #11 is updated, and #6 is deferred (needs hand-labelled data).
- Still open: the Caddy deploy (`sudo ./scripts/apply_updates.sh` in homelab, needs the user's password), phone checks (#1, #2, #7), and #8.

## State of `main` (local, not pushed, not deployed)

| Commit | What |
|---|---|
| `1e0847a` | `PLAYWRIGHT_PORT` env overrides the browser-test port (default 4173), so several checkouts can run Playwright at once |
| `21674c6` | merge `torrent-health` (#3) |
| `5043079` | merge `prowlarr-source` (#4): Prowlarr as an additional audiobook source |
| `58e2236` | test expectation fix after combining #3 and #4 |
| `f4bd3ef` | merge `fix-ui-alignment` (#1, #2): Now Playing alignment fix and layout tests |

Verified on merged `main`: `npm run build` OK, `npm test` 97/97, `npm run test:browser` 47/47 (Chromium plus Firefox for the layout spec; WebKit is not installed).

`CLAUDE.md` has an uncommitted edit that predates this session (Caddy is managed from `/home/jahn/homelab`). Left as is.

## Per issue

### #1 Misaligned UI / #2 Reader-first layout: done, merged
- Audited Now Playing at 360/390/430/1280 px. The one remaining offset was the dialog title, 1.3–1.5 px off the close button; it now shares a `--dialog-title-line` variable. That moves every dialog's close button by at most 1.5 px.
- New `tests/e2e/now-playing-layout.spec.ts` checks the geometry and the #2 reader-first rules.
- The production `sonder` container serves exactly `4c06d2d` (main before this session). That resolves the "two Codex threads" concern in #11.
- Still open: checks on a real phone and in iOS Safari/WebKit. **Deploy** (below).

### #3 transmission-openvpn unhealthy: fixed live, app changes merged
- Root cause: PIA's pushed in-tunnel DNS `10.0.0.243` answered REFUSED. That broke the healthcheck, port forwarding, DHT and tracker lookups.
- **Applied live**, at the user's request:
  - `/home/jahn/homelab/docker/docker-compose.yml`, service `transmission`: `PEER_DNS=false`, `OVERRIDE_DNS_1=1.1.1.1`, `OVERRIDE_DNS_2=9.9.9.9`. Backup of the previous file: `data/backups/homelab-docker-compose.yml.before-dns-override-*`. `homelab/backups/` was not writable.
  - Recreated `transmission-openvpn`. It is healthy, resolves DNS, and exits through the VPN in DE (the host exits in NO, so there is no leak).
  - Recreated `sonder-torrents` with `scripts/setup-local-torrents.mjs`, because it shares the VPN container's network namespace. `.env` was backed up to `data/backups/env.before-torrent-recreate-*`. The RPC URL is unchanged (`172.17.0.2:9092`), so the `sonder` container needed no restart. Transmission state in `data/transmission` was kept.
- After the fix: RPC OK and `port-test` answers. The incoming port is reported closed, because Sonder's queue disables port forwarding; that is slower but works. "Game of Thrones" was at 0.11% with 1 peer right after the restart. It has no trackers and relies on DHT, so re-check whether it progresses.
- The shared Transmission used by radarr/sonarr was restarted twice in the process.
- App side (merged): `GET /api/torrents/health[?fresh=1]`, a status line in Settings → Your home server, a warning in Downloads, and `acquire()` refusing the local fallback with a clear error instead of queueing a dead torrent.
- Decision for the user: the health check uses Transmission's `port-test` (portcheck.transmissionbt.com). If that service is down, local fallback is refused even with a working VPN. When the client is unhealthy, adding a torrent can take about 15 s longer.

### #4 More audiobook sources: done, merged
- Prowlarr client (categories 3030; 7000 only for audio-looking titles). Download links carry the Prowlarr key, so the server keeps them for 6 h and replays them only against the configured Prowlarr address (`/<id>/download` path only, manual redirects, magnet only).
- The release picker loads AudioBookBay and Prowlarr independently, with a note per source when one fails. It dedupes by infohash, then by title plus size within 1%, and sorts by match, TorBox cache, then seeders. Releases go through the existing TorBox-cached → local Transmission → validation routing.
- Settings: a Prowlarr section (address, encrypted API key, Test). No schema change.
- Live search against the local Prowlarr (no downloads):

  | Search | ABB (page 1) | Prowlarr | Merged |
  |---|---|---|---|
  | "project hail mary" | 9 | 4 (52 s) | 10 |
  | "the hobbit" | 9 | 32 | 40 |
  | "dune" | 9 | 44 | 53 |
- To do: enter the Prowlarr URL and API key in Settings after deploy. The local Prowlarr's key is in its config volume; it was deliberately not committed.
- Decisions for the user: Prowlarr searches can take about 50 s (90 s timeout; ABB results show first). Indexer results carry no language, so they appear under every language filter.

### #5 Reading sync for single-file releases: implemented, NOT merged (branch `single-file-sync`, `201db27`)
- Samples anchors across the audio, aligns overlapping windows between them and stitches the results into the existing map, adding intro/outro/skipped/extra flags and refusing a mismatched edition. It uses only the existing worker endpoints, so `sonder-alignment` needs no rebuild.
- Tests on the branch: build OK, 86/86 unit, 28/28 browser.
- Dry run on real media (Jeff Hays DCC with chapters ignored) was halted after 5 of 85 windows. Against the chapter map: median 0.005 s, max 1.69 s. Whole-book coverage was not measured.
- Next: finish the dry run, then merge. Testing the truly chapterless "Unknown narrator" DCC release needs it saved to the HDD first (Save to server), which writes to production, so ask the user.

### Not started
- #6 needs hand-labelled timing data.
- #7 needs the user's phone.
- #8 needs a decision (member key, another mirror, keep the browser handoff, or try the local FlareSolverr).
- #9 and #10 are deferred.

## Pending actions

1. **Caddy: `audiobooks.pecori.no` still shows Audiobookshelf.** `homelab/staging/etc/caddy/Caddyfile` correctly points it at `127.0.0.1:3001`, but staging was never deployed. The live `/etc/caddy/Caddyfile` still has `127.0.0.1:13378`. The user must run `cd /home/jahn/homelab && sudo ./scripts/apply_updates.sh` (needs a sudo password). The other staged configs that could be checked are identical to live; `wg0.conf` and cloudflare-ddns could not be read without sudo. Audiobookshelf then needs its own subdomain if it should stay public.
2. **Deploy merged `main`** (needs the user's go-ahead): `cp data/sonder.db data/backups/before-roadmap-$(date +%s).db && docker compose build && docker compose up -d --no-build`. Then configure Prowlarr in Settings and check the torrent status line.
3. **Push and update the issues** (needs the user's go-ahead): push `main`, and comment on or close #1, #2, #3 and #4 with the results above. #5 stays open until `single-file-sync` is merged.
4. Finish #5 (above).

## Orca and worktree cleanup

- Orca run `run_3b9f2c1dccd1`: every Task has settled and every worker is released.
- The repo was registered in Orca as a folder project, which cannot create worktrees. As a workaround, git worktrees were created by hand and each was added as its own Orca repo. That is why the Agents board grouped them oddly:
  - `/home/jahn/sonder-worktrees/fix-ui-alignment` (merged)
  - `/home/jahn/sonder-worktrees/torrent-health` (merged)
  - `/home/jahn/sonder-worktrees/prowlarr-source` (merged)
  - `/home/jahn/sonder-worktrees/single-file-sync` (**unmerged work**)
- When recreating the project, register `/home/jahn/audiobook_streamer` as a **git** project so Orca can create worktrees itself. Remove the four extra Orca repos. On disk, remove the merged worktrees with `git worktree remove /home/jahn/sonder-worktrees/<name>` and `git branch -d <name>`. Keep `single-file-sync` until it is merged.
- Per-worker files under each worktree's `artifacts/` (gitignored) are copied into this folder where they matter.
