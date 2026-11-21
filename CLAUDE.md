# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` before any orchestration, CI, worker or review task.

## What this is

Sonder: a self-hosted, single-user, mobile-first audiobook PWA (with a built-in EPUB reader and local ebook/audio alignment) running on this Ubuntu server. Production is live at https://sonder.pecori.no (Caddy → loopback port 3001). Caddy is managed by `/home/jahn/homelab`: change the site block in `homelab/staging/etc/caddy/Caddyfile` and deploy with `sudo ./scripts/apply_updates.sh` — never edit `/etc/caddy/Caddyfile` directly, it is overwritten from staging on every homelab deploy. `deploy/audiobooks.caddy` is only a copy for reference. `README.md` is the detailed behaviour spec — read the relevant section before changing a workflow. Status, roadmap and known issues are tracked in GitHub issues (pinned issue #11) on `jahnzh/sonder`.

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

Playwright starts `tests/browser-server.ts`, which runs the real app on :4173 against a throwaway temp DB/media dir with AudiobookDB/Open Library, Prowlarr, series and alignment fixtures installed (`tests/*-fixture.ts`) and no password. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if the pinned Chromium path in `playwright.config.ts` is missing.

Deploy (production runs from Docker, not `npm start`); use `scripts/deploy-prod.sh <commit>` from any checkout — see `docs/LOCAL_CHECKS.md` (Production deployment).

```bash
npm run backup -- data/sonder.db data/backups/before-<change>-$(date +%s).db
docker compose build && docker compose up -d --no-build
```

`scripts/verify-playback-workflow.mjs [recording-id]` and `scripts/verify-integrated-reader.mjs [recording-id]` exercise the **deployed** UI with real media and refuse production unless `SONDER_VERIFY_PRODUCTION=1` is set (deploy.sh sets it; point `SONDER_VERIFY_URL` at a local test server on loopback, not port 3001, otherwise); they intercept progress writes so the user's real listening position isn't changed, and write results to `artifacts/` (gitignored). Any new live-verification script must protect progress the same way.

For isolated checks of a committed revision, database backups, and live-verification safeguards, read `docs/LOCAL_CHECKS.md` before running those workflows.

## Architecture

**One process** (`compose.yaml`):
- `sonder` — Fastify server (`server/`) that also serves the built SPA from `dist/`. Runs TypeScript directly through `tsx` (no server build step), host networking, read-only rootfs. The Dockerfile's runtime stage copies `node_modules`, `dist/`, `server/`, `scripts/image-smoke.mjs`, `package.json`, `tsconfig.json` and, from `src/`, only `src/types.ts`, `src/series-selection.ts`, `src/appearance.ts`, `src/reading-types.ts` and `src/prepared-text-rules.ts`, so **any other `src/` file imported by the server breaks the production image**.
- External, alignment: the remote CTC pool (ADR 0006, `docs/CTC_WORKER_POOL.md`). The Python FastAPI worker (`worker/align.py`, token-protected, port 3012) runs only on the pool hosts, WSL's GPU first and lisa's CPU as the fallback, installed by `scripts/install-ctc-workers.sh`; production runs no alignment worker (the `sonder-alignment` container was retired in #279). It does known-text forced alignment, candidate probing and short-excerpt passage locating; models live under each worker's `MEDIA_ROOT/alignment` and are fetched only by `download_model.py`. Server side lives in `server/alignment.ts` and `server/alignment-pool.ts` (SSH staging, host leases); reading sync is available only with `ALIGNMENT_POOL_ENABLED=1` and `ALIGNMENT_WORKER_TOKEN`.
- External: a dedicated Transmission (`sonder-torrents`) sharing the network of the user's existing `transmission-openvpn` container, configured by `scripts/setup-local-torrents.mjs` (writes credentials into `.env`).

**Server layout.** `server/index.ts` loads `.env` and calls `createApp()` in `server/app.ts`, which holds auth, the core library/progress/media routes and the background tickers. Feature areas register their own routes: `catalogue-routes.ts` (AudiobookDB/Open Library: `audiobookdb.ts`, `openlibrary.ts`, `catalogue-links.ts`), `series-routes.ts` (series on AudiobookDB's ids), `hardcover-routes.ts` (the 410s of the removed Hardcover routes, plus two work routes that never read Hardcover), `reader.ts`, `alignment.ts`, `appearance.ts`, `media-library.ts` (sources/faulty flags/copy choice). Other key modules:
- `services.ts` — TorBox API and AudioBookBay scraping.
- `acquisitions.ts` + `transmission.ts` — magnet routing: TorBox only on a confirmed cache hit (`add_only_if_cached`), otherwise local Transmission. A book is added to the library only after the torrent completes and its files validate.
- `downloads.ts` — "Save to server" copies to `MEDIA_ROOT/saved`.
- `ebooks.ts` + `sources/` — Anna's Archive / LibGen parsers and EPUB/PDF import.
- `prepared-text.ts` + `prepared-text-cache.ts` — an EPUB as sanitised HTML in parts with every sentence of `extractBook` tagged by its id, a manifest, and the disk cache and routes under `/api/reader/:id/prepared` (README "Prepared text", ADR 0025). It never cuts sentences itself; the client does not use it yet. Preparing runs on a worker thread per book (`prepared-text-worker.ts`, which must not import the database), and `prepared-text-ahead.ts` prepares books ahead: at import, by an hourly sweep, and through `scripts/prepare-library.sh` (#827). A change to its output raises `PREPARED_TEXT_VERSION`.
- `storage.ts` — `MEDIA_ROOT` paths and the HDD volume-marker check. With `REQUIRE_MEDIA_MOUNT`, media writes are refused if the 4 TB mount is missing.
- `range.ts` / `media-response.ts` — byte-range serving and proxying of upstream media. The proxy only accepts stored source records, never arbitrary URLs.

**Database.** SQLite via better-sqlite3 in `DATA_DIR` (default `data/`). There is no migration tool: `server/db.ts` runs `CREATE TABLE IF NOT EXISTS` and guarded `ALTER TABLE ... ADD COLUMN` checks (via `PRAGMA table_info`) at startup. `server/schema.ts` is the Drizzle mirror. A schema change must update **both** files and stay additive, because the live DB has real data. Integration secrets are AES-256-GCM encrypted with `data/.encryption-key`.

**Data model.** `works` → `audio_editions` (the "book" a library row points at) → `recordings` → `tracks`. Ebooks are `ebook_editions` hanging off the same `work`. Progress is keyed **per recording** (track + position), so each release keeps its own position; never merge progress across recordings. "Delivery source" (device copy / server HDD copy / original stream or TorBox) is separate from the choice of recording. Removing a library row adds a `hidden_library` entry so nothing re-adds it; files and progress are kept.

**Client (`src/`).** React 19 + Tailwind 4 (its reset only; components use the app's own classes) + Radix dialog and popover. `main.tsx` mounts `App.tsx`, which reads the address and shows the place, page, sheet or Now playing it names inside the shell.
- **Shell** (`shell.tsx`, `shell.css`): one `nav` named "Main" with the four places (Library, Discover, Activity with its attention dot, Settings) is the tab bar under the mini player below 760 px and the rail with "Sonder" from 760 px; the offline line (`connection.ts`) shows while the device has no connection; the toast carries messages outside the reader. The mini player is `PlayerDock` in `components/Player.tsx`, and it opens Now playing.
- **Pages** (`src/pages/`): one module per page or sheet, each with its stylesheet beside it and its rules in a pure `*-model.ts` / `*-state.ts` where they are worth a unit test: `library-page.tsx`, `discover-page.tsx`, `activity-place.tsx` (Now, This device, Server and a worker's page), `settings-page.tsx` with its pages in `pages/settings/`, `book-page.tsx` and the Audiobook, Ebook, Reading sync, Match and Edit pages, the Get sheets (`get-audiobook-sheet.tsx`, `get-ebook-sheet.tsx`, `get-magnet-sheet.tsx`), `series-page.tsx` with its Add sheet, and `now-playing.tsx`. The words on screen come from `status-lines.ts` and `tooltip-texts.ts`.
- **Parts and tokens** (`src/parts/`, `src/parts/README.md`): one file per part (`Row.tsx`, `Group.tsx`, `PageHeader.tsx`, `Sheet.tsx`, `Picker.tsx`, `Tooltip.tsx`, …) with its own stylesheet and class `part-<name>`. Spacing, corners, heights and text styles are the tokens in `parts/tokens.css` (`tests/parts-tokens.test.ts` pins them); colours are the variables of `appearance.css`, so every preset applies. `#gallery` (`src/gallery/`, linked from nowhere) shows each part in each state for the browser tests.
- **Addresses and Back** (ADR 0020): `routes.ts` is the one pure module that reads and writes a hash address, names a page's parent (`parentOf`) and keeps the old names in one table (`OLD_NAMES`, e.g. `#downloads` → `#activity`, read as a redirect). `navigation.ts` makes the browser's history the page stack: opening a page, a place, a sheet or Now playing adds an entry; switching Activity's parts, Now playing's faces or following a redirect replaces it; a page's back button goes where the user came from, else to its parent. Pickers, tooltips and confirmations are not entries.
- **Now playing** (`pages/now-playing.tsx`): one screen at `#listen/<workId>` and `#read/<workId>` with two faces switched in its head. Listen: cover, timeline, transport, then Speed, Sleep timer, Chapters, Plays from, Earlier positions and Keep on this device. Read: the reader's page (`components/Reader.tsx`): head, text band and foot with nothing over the text (ADR 0019), in pages or scroll mode (ADR 0017); Chapters, Bookmarks and Search are pages. The face it opens on is `now-playing-face.ts`.
- **The new reading view** (README "The new reading view", #802; behind `?reader-view=prepared`, remembered per device by `reader-view-switch.ts`): `components/Reader.tsx` is the reader of both views and branches at its epub.js calls; `prepared-view.ts` is the text band of prepared text in scroll mode (parts loaded as read), `prepared-book.ts` the manifest, parts and sentence places, `prepared-html.ts` the walk that makes a part's nodes against `prepared-text-rules.ts`. Without the switch nothing of it runs.
- **Playback and offline.** Playback state and Media Session live in `player.tsx` (30 s skips for every remote command, including next/previous). Dexie (`lib.ts`) stores offline state: device downloads as 4 MiB IndexedDB chunks (`media-download.ts`), Keep on this device (`keep*.ts`, ADR 0018/0021), queued progress and reader checkpoints. `public/sw.js` is a template; `scripts/build-sw.mjs` injects the precache list and version into `dist/sw.js`, and the service worker serves byte ranges from complete device downloads. `__SONDER_BUILD_ID__` / `dist/build.json` drive the in-app "update available" notice (`app-update.ts`, `components/AppUpdate.tsx`).
- **Checks that keep it clean** (unit tests in `npm test`): `scripts/check-unused-modules.mjs` (`tests/check-unused-modules.test.mjs`) fails on a file under `src/` that neither `main.tsx`, `server/index.ts`, `scripts/build-sw.mjs` nor a `scripts/verify-*.mjs` reaches; a module only a test imports is dead, so delete it with its test. Two stylesheet checks join it: `scripts/check-unused-classes.mjs` (`tests/check-unused-classes.test.mjs`) fails on a class in a `src/` stylesheet that the app's code never sets, and `scripts/check-stylesheet-tokens.mjs` (`tests/check-stylesheet-tokens.test.mjs`) on a corner or spacing value in any `src/` stylesheet that is not a token, built from tokens, or marked `/* tokens: <reason> */` as an exception, whose number the test pins (ADR 0023).

**Sync rules.**
- Progress is saved locally first and reconciled with the server by timestamp.
- Hardcover sync is removed (#721 part d): nothing is sent to or pulled from Hardcover. The catalogue is AudiobookDB (audiobooks) and Open Library (books without one): a work links to a catalogue book, a recording may link to a release; covers and descriptions are shown by URL, never stored. Want to read is Sonder's own shelf; Reading and Finished come from the user's progress.
- Reader positions use CFIs plus sentence locators, not page numbers.
- A sentence id is its chapter file and its count there (`extractBook`). The block rule in `src/reading-types.ts` decides the count, so a change to it or to the extractor is proved with `scripts/compare-extractor.ts` over the library: every book it does not mean to change stays identical (ADR 0026).
- Alignment maps belong to one specific recording and EPUB. They are invalidated when either file changes, and their timings are labelled "estimated".

## Conventions

- UI copy: keep text that has a function (labels, status, instructions) and leave out taglines and decorative descriptions — the user explicitly removed those app-wide.
- Older client builds may still be open in the user's browser. Keep endpoints tolerant of earlier request shapes (e.g. a DELETE or POST with an empty JSON body).
- Work is checked in the real UI with the user's actual media, not just with fixtures; the user has called out fixture-only verification before.
- `.env`, `data/`, `artifacts/`, `.codex-attachments/` are gitignored and must stay that way.
