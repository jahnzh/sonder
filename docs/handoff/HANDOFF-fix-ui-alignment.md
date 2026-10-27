# Handoff: fix-ui-alignment (issues #1, #2)

> **Historical note.** This records one working session on 2026-10-27 and is not current instructions. Sonder is live at https://sonder.pecori.no (Caddy → 127.0.0.1:3001); see `README.md` for the current setup.

Branch `fix-ui-alignment`, commit on top of 4c06d2d (see `git log -1`).

## Deployed vs main
- Running `sonder` container: image created 2026-10-27T10:54:04Z, started 10:54:05Z; `build.json` id 2026-10-27T10:53:43Z. Commit 4c06d2d is timestamped 10:55:12Z (the commit was made after the build), not a mismatch.
- Content check: rebuilt HEAD locally and diffed the served bundles from 127.0.0.1:3001. CSS hash is identical. All JS chunks are byte-identical once the embedded build ID and chunk filenames derived from it are normalised. Every git-tracked server file (`server/`, `src/types.ts`, `src/appearance.ts`, `src/reading-types.ts`) matches `/app` in the container. **Production serves main HEAD (4c06d2d).**
- **Routing finding (resolved: Sonder is served at `sonder.pecori.no`; nothing to change):** https://audiobooks.pecori.no currently serves **Audiobookshelf**. `/etc/caddy/Caddyfile` line 62 proxies that host to 127.0.0.1:13378 (the audiobookshelf container), not 3001. No Caddy site points at Sonder's port 3001, so Sonder is reachable only on loopback. `deploy/audiobooks.caddy` expects 3001. The user needs to decide; nothing was changed.

## Done
- Audit in Chromium at 360x740, 390x844, 430x932 and 1280x800 for the dock and both Now Playing variants (plain and reader-first). Seek labels, arrows and buttons share a centre within 0.01px. Play is centred between the seeks. The options sheet does not overflow.
- One remaining misalignment fixed: the plain Now Playing (generic Dialog) title sat 1.3–1.5px below the close button's centre. Fixed in `src/styles.css` with a `--dialog-title-line` variable (desktop and the 650px rule) so the title line-height and the close button's margin come from the same value at any UI scale. This affects every dialog heading by at most 1.5px.
- New `tests/e2e/now-playing-layout.spec.ts`, with 8 tests per browser covering the geometry and #2 checks (EPUB bg = dialog bg, reader viewport > 60% of viewport height, Title page and Versions buttons only in the ⋯ sheet, Escape closes the sheet and returns focus, then a second Escape closes the dialog).
- `playwright.config.ts`: Firefox/WebKit projects run only this spec, and only when the browser binary is installed. Firefox 1555 is installed; WebKit is not, so it is skipped automatically.

## Test status
- `npm run build` passes. `npm test` gives 79/79. `npm run test:browser` gives 43/43 (35 Chromium + 8 Firefox). The layout spec passed on two more consecutive runs in both browsers.
- Coordinator commit 1e0847a (PLAYWRIGHT_PORT) is not cherry-picked. The runs used port 4173 after waiting for it to be free.

## Not verified / manual
- WebKit/iOS Safari (not installed). Real phone with the user's real media, including safe-area insets and the iOS dynamic toolbar.
- Plain (no-ebook) Now Playing on short phones (360x740): the transport sits below the fold inside the scrolling dialog. It is aligned but needs a scroll. This is a design choice, not changed.
- The heading change touches all dialogs (by ≤1.5px). A quick visual check of Book details and Media manager is worthwhile.
