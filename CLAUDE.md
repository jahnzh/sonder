# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sonder: a self-hosted, single-user, mobile-first audiobook PWA (with a built-in EPUB reader and local ebook/audio alignment) running on this Ubuntu server. Production is live at https://audiobooks.pecori.no (Caddy → loopback port 3001; site block in `deploy/audiobooks.caddy`). `README.md` is the detailed behaviour spec — read the relevant section before changing a workflow. Status, roadmap and known issues are tracked in GitHub issues (pinned issue #11) on `jahnzh/sonder`.

## Commands

```bash
npm run dev            # tsx watch API on :3001 + Vite on :5173 (proxies /api). Stop the prod container first — same port.
npm run build          # tsc --noEmit (typecheck: there is no linter) + vite build + scripts/build-sw.mjs
npm test               # node:test via tsx, tests/*.test.ts
npm run test:browser   # Playwright, tests/e2e/*.spec.ts, single worker, 390x844 viewport

npx tsx --test tests/range.test.ts                      # one unit file
npx tsx --test --test-name-pattern "pattern" tests/x.test.ts
npx playwright test tests/e2e/releases.spec.ts -g "name" # one browser test
```

**Browser tests serve the built `dist/`, not the source — run `npm run build` before `npm run test:browser`**, or the tests silently exercise the previous build.

Playwright starts `tests/browser-server.ts`, which runs the real app on :4173 against a throwaway temp DB/media dir with Hardcover and alignment fixtures installed (`tests/*-fixture.ts`) and no password. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if the pinned Chromium path in `playwright.config.ts` is missing.

Deploy (production runs from Docker, not `npm start`):

```bash
npm run backup -- data/sonder.db data/backups/before-<change>-$(date +%s).db
docker compose build && docker compose up -d --no-build
```

`scripts/verify-playback-workflow.mjs` and `scripts/verify-integrated-reader.mjs <recording-id>` exercise the **deployed** UI with real media; they intercept progress writes so the user's real listening position isn't changed, and write results to `artifacts/` (gitignored). Any new live-verification script must protect progress the same way.

For isolated checks of a committed revision, database backups, and live-verification safeguards, read `docs/LOCAL_CHECKS.md` before running those workflows.

## Architecture

**Two processes** (`compose.yaml`):
- `sonder` — Fastify server (`server/`) that also serves the built SPA from `dist/`. Runs TypeScript directly through `tsx` (no server build step), host networking, read-only rootfs. The Dockerfile copies only `server/` plus `src/types.ts`, `src/appearance.ts` and `src/reading-types.ts`, so **any other `src/` file imported by the server breaks the production image**.
- `sonder-alignment` — Python FastAPI worker (`worker/align.py`) on 127.0.0.1:3012, token-protected, 2 CPU / 6 GB. Does known-text forced alignment and short-excerpt speech recovery; models live under `MEDIA_ROOT/alignment` and are fetched only by `download_model.py`. Server side lives in `server/alignment.ts`.
- External: a dedicated Transmission (`sonder-torrents`) sharing the network of the user's existing `transmission-openvpn` container, configured by `scripts/setup-local-torrents.mjs` (writes credentials into `.env`).

**Server layout.** `server/index.ts` loads `.env` and calls `createApp()` in `server/app.ts`, which holds auth, the core library/progress/media routes and the background tickers. Feature areas register their own routes: `hardcover-routes.ts`/`hardcover.ts`, `reader.ts`, `alignment.ts`, `appearance.ts`, `media-library.ts` (sources/faulty flags/copy choice). Other key modules:
- `services.ts` — TorBox API and AudioBookBay scraping.
- `acquisitions.ts` + `transmission.ts` — magnet routing: TorBox only on a confirmed cache hit (`add_only_if_cached`), otherwise local Transmission. A book is added to the library only after the torrent completes and its files validate.
- `downloads.ts` — "Save to server" copies to `MEDIA_ROOT/saved`.
- `ebooks.ts` + `sources/` — Anna's Archive / LibGen parsers and EPUB/PDF import.
- `storage.ts` — `MEDIA_ROOT` paths and the HDD volume-marker check. With `REQUIRE_MEDIA_MOUNT`, media writes are refused if the 4 TB mount is missing.
- `range.ts` / `media-response.ts` — byte-range serving and proxying of upstream media. The proxy only accepts stored source records, never arbitrary URLs.

**Database.** SQLite via better-sqlite3 in `DATA_DIR` (default `data/`). There is no migration tool: `server/db.ts` runs `CREATE TABLE IF NOT EXISTS` and guarded `ALTER TABLE ... ADD COLUMN` checks (via `PRAGMA table_info`) at startup. `server/schema.ts` is the Drizzle mirror. A schema change must update **both** files and stay additive, because the live DB has real data. Integration secrets are AES-256-GCM encrypted with `data/.encryption-key`.

**Data model.** `works` → `audio_editions` (the "book" a library row points at) → `recordings` → `tracks`. Ebooks are `ebook_editions` hanging off the same `work`. Progress is keyed **per recording** (track + position), so each release keeps its own position; never merge progress across recordings. "Delivery source" (device copy / server HDD copy / original stream or TorBox) is separate from the choice of recording. Removing a library row adds a `hidden_library` entry so Hardcover sync won't re-add it; files and progress are kept.

**Client (`src/`).** React 19 + Tailwind 4 + Radix dialogs. `App.tsx` is a large single-file shell with hash routes (`#library`, `#discover`, `#settings`, …). Playback state and Media Session live in `player.tsx` (30 s skips for every remote command, including next/previous). Dexie (`lib.ts`) stores offline state: device downloads as 4 MiB IndexedDB chunks (`media-download.ts`), queued progress and reader checkpoints. `public/sw.js` is a template; `build-sw.mjs` injects the precache list and version into `dist/sw.js`, and the service worker serves byte ranges from complete device downloads. `__SONDER_BUILD_ID__` / `dist/build.json` drive the in-app "update available" notice (`AppUpdate.tsx`).

**Sync rules.**
- Progress is saved locally first and reconciled with the server by timestamp.
- Hardcover writes go through durable SQLite queues: one for listening and a separate one for reading. They are coalesced and retried, and a newer local position must never be overwritten by an older remote response.
- Reader positions use CFIs plus sentence locators, not page numbers.
- Alignment maps belong to one specific recording and EPUB. They are invalidated when either file changes, and their timings stay labelled "estimated" until reviewed.

## Conventions

- UI copy: keep text that has a function (labels, status, instructions) and leave out taglines and decorative descriptions — the user explicitly removed those app-wide.
- Older client builds may still be open in the user's browser. Keep endpoints tolerant of earlier request shapes (e.g. a DELETE or POST with an empty JSON body).
- Work is checked in the real UI with the user's actual media, not just with fixtures; the user has called out fixture-only verification before.
- `.env`, `data/`, `artifacts/`, `.codex-attachments/` are gitignored and must stay that way.
