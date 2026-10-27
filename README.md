# Sonder

A dark, mobile-first, self-hosted audiobook PWA inspired by [Vaka](https://github.com/vaka-hq/mobile). React, TypeScript, Vite, Tailwind, Radix dialogs, Fastify, SQLite/Drizzle, and Dexie. No Vaka account is needed.

## Run on this Ubuntu server

Node 24 and Docker are required. The 4 TB drive is mounted at `/mnt/usb_4t_1`. Media lives in `/mnt/usb_4t_1/sonder`; the app refuses to write media to the root filesystem if that mount is missing.

```bash
npm ci
node scripts/setup-local-torrents.mjs
# The setup script generates APP_PASSWORD privately in .env if one is not set.
docker compose build
docker compose run --rm --no-deps alignment-worker python download_model.py
docker compose up -d --no-build
```

Open **https://sonder.pecori.no** and sign in with `APP_PASSWORD` from `.env`. Caddy proxies this domain to the loopback-only app on port 3001; HTTPS cookies are enabled. The site block is recorded in `deploy/audiobooks.caddy`. For development, `npm run dev` starts the frontend at **http://localhost:5173** and the API at port 3001. Stop the production container before running development on the same API port. The server reads `.env` at startup.

`setup-local-torrents.mjs` creates a dedicated `sonder-torrents` Transmission 4 queue using the installed image and the **existing `transmission-openvpn` container’s network**. It does not change the existing daemon or its downloads. Its RPC uses port 9092, requires generated credentials, and is not published on the host. A stable volume marker is checked by both the app and the torrent daemon, so Docker cannot silently redirect media onto the system disk when the HDD is absent. Both incomplete and completed audiobook files are on the HDD. Credentials are written to the ignored, private `.env`; daemon settings live under ignored `data/transmission/`. If the VPN container is recreated with a different private IP, run the setup script again and restart Sonder. The VPN container must be running before the torrent queue starts.

The app container binds to loopback. Put an HTTPS reverse proxy in front of it for phone access and set `COOKIE_SECURE=true`. PWA installation, OPFS, and service workers require HTTPS or localhost. On first use, add your TorBox key in Settings to enable cached streaming; without it, magnet links use the local client.

## Listening workflow

1. Browse the included public-domain recordings, search AudioBookBay, import your audio files, or add a magnet link. AudioBookBay search has a release picker with language (English by default), format, size, bitrate, narrator details and pagination. Confirm **Use this release** before anything is queued. **Find another release** on a book keeps the new recording linked to the same work; available recordings can be switched in the book dialog and retain independent progress. Filename order is natural, so chapter 2 precedes chapter 10.
   With Prowlarr connected (Settings → **Prowlarr**: address plus API key, stored encrypted; **Test Prowlarr** checks status and counts enabled torrent indexers), the picker also searches Prowlarr’s audiobook category (3030) and book categories (7000, kept only when the title marks it as audio). Sonder only reads Prowlarr; indexers are managed there. Each source fills in as it answers, and a failing source shows a short note above the others. Releases are merged by info hash, then across sources by normalized title and size within 1%; merged cards list every source. Results sort by title match, then TorBox cache (known hashes only), then seeders. Indexers do not report language, so their releases stay visible under every language filter. Prowlarr download links contain its API key and never reach the browser: the server keeps them for six hours per search and replays them only against the configured Prowlarr address, turning a magnet redirect or `.torrent` file into a magnet. A chosen Prowlarr release then follows the same TorBox check, local queue and validation as any other magnet. Prowlarr results load on the first page only; **Load more releases** pages AudioBookBay.
2. A magnet is checked against TorBox’s cache. Only a positive cache match creates a TorBox torrent, with `add_only_if_cached=true` to protect against a cache race. A miss or unavailable TorBox API uses local Transmission.
3. Local downloads run independently of the browser. The persistent server queue shows checking, preparing, downloading, paused, ready, and error states. Stable info hashes deduplicate repeated requests. Downloads resume after an application restart. A book joins the library only after Transmission reports completion, every wanted audio file is complete, and local metadata can be read. Preallocated partial files are never considered playable.
4. Listen with 30-second forward/back controls, speed, volume, a sleep timer, and Media Session controls. Headphone/lock-screen next, previous and seek commands all jump 30 seconds, including across audio files with known durations, while preserving paused playback. Choose chapters explicitly from the chapter list. Imported and locally downloaded M4B/MP3 files expose their embedded QuickTime, Nero, or ID3 chapters; the physical file and recording identity remain unchanged when seeking between chapters. Streaming files obtain embedded metadata when saved to the server; multi-file streams expose one chapter per file until then. Progress is keyed by recording and track, saved locally every five seconds and on pause/seek, then reconciled with the server by timestamp.
5. **Save to server** keeps a permanent copy on the HDD, including TorBox or LibriVox streams. Complete chapters survive pause/retry/restart; interrupted chapter files are removed or replaced, and completed media is committed atomically. Keeping a cached recording does not change its recording identity or listening progress.
6. **Save offline / Save on device** keeps a complete copy in the current browser using persistent IndexedDB chunks. Completed chapter metadata is written only after size validation. Keep the tab open while downloading; pause or retry can reuse completed sections after reload. Partial books show completed chapter counts; only fully downloaded books receive the offline badge. This copy is independent of the server copy.

Settings → **Playback** chooses a whole-audiobook or current-chapter progress bar. Chapter mode uses embedded chapters inside M4B files. Whole-audiobook mode spans files when their durations are known; otherwise it explicitly shows the current file. Drag the bar horizontally to seek; moving farther above or below it reduces sensitivity. The drag previews your destination and seeks on release; keyboard arrows seek one second. Both player bars expand on wider screens.

The compact player’s cover opens the title page and its book icon opens a linked EPUB. The expanded player puts **Title page**, **Read ebook** and **Versions & sources** at the top. Matched title pages link directly to the book’s canonical Hardcover page. If multiple EPUBs are linked, choose an edition once; Sonder remembers it for that work.

**Versions & sources**, also available on title pages and device-download rows, separates recordings from their delivery sources. Choose Automatic, Device copy, Server HDD copy or the original online/TorBox stream. Switching delivery source preserves position and paused playback. Switching recordings resumes that recording’s own checkpoint. Automatic prefers a healthy device copy, then server media, then the original stream; explicitly selected sources never silently fall back. Mark an entire recording or an individual copy faulty with a reason and optional note. Device flags stay on the device; recording/server/original flags persist on the server. Clear a flag when resolved. Removing a downloaded copy preserves the library and progress. Server removal deletes only managed downloads in `MEDIA_ROOT/saved`, preserving original imports and torrent files.

Library entries, saved server media, acquisitions, settings, and progress survive restarts in SQLite and the media drive. Removing a library entry preserves its files and progress, and records that choice so Hardcover sync will not add it back; explicitly adding it again restores the entry. Older clients sending an empty JSON body on library DELETE are supported. Browser favorites are device-local. New library mutations need a server connection; playback progress works offline and syncs later.

## Hardcover library and reading progress

Hardcover organizes the library as well as supplying metadata. Add your token in Settings, save it, then use **Hardcover library & progress** to test the account, choose a sync mode, and sync now.

- **Off** keeps catalog search and explicit book matching available.
- **Import only** brings your reading shelves, custom lists, and available reading positions into Sonder without writing to Hardcover.
- **Two-way** also publishes listening status and progress. Pending changes are stored in SQLite, coalesced to the latest position, and retried after outages. The server checks pending changes roughly once a minute and refreshes the full remote library every 15 minutes. Sync now runs immediately.

Use a token with `read:catalog`, `read:library`, and `read:me:content`. Two-way shelves/progress need `write:library`. Lists need `read:lists` and `write:lists` to edit membership. These are described in [Hardcover’s scope catalog](https://github.com/hardcoverapp/hardcover-docs/blob/main/capabilities.json). Missing optional list permissions retain the previous list cache and show a warning.

Reading shelves and custom lists appear as filters in the library. Exact, unique title-and-author matches link existing books automatically; other entries become metadata-only books with **Find audio**. A book’s detail view offers manual matching, shelf changes, list membership, recording-edition selection, and **Use Hardcover position**. Removing a local library entry does not delete the Hardcover entry or any media files.

Progress uses the cumulative position across physical tracks. It maps by percentage to the selected Hardcover audio edition’s duration, or to pages when Hardcover has no audio edition but does have a page count. Incoming page progress also maps proportionally onto the local recording. This is approximate cross-format progress, not sentence alignment. Unknown chapter durations are never guessed: play or save the audio on your server to read its metadata first.

Local playback stays authoritative while its changes are queued. Later remote changes can move a position backward as well as forward. An unchanged remote checkpoint is not repeatedly imported. A first import preserves a newer local position; two-way mode publishes that position on the first sync. **Use Hardcover position** explicitly selects the remote position and resumes playback. Matching preserves recording IDs, file paths, and each recording’s own progress. Switching account tokens disables sync and clears account-specific queues/list caches before another account can be used.

## Ebook sources

Discover → Ebooks searches **Library Genesis**; its mirror is configurable in Settings. It requires no key; unavailable mirrors are reported instead of appearing to return no matches. Anna’s Archive was removed for now (#8). Older clients that still ask for it get a clear refusal.

To add a file from elsewhere, download the EPUB/PDF and use **Import ebook** on your ebook shelf. Imports stream to `MEDIA_ROOT/ebooks`, have a 150 MB limit, validate file signatures, deduplicate identical files and persist through restarts. Importing through an audiobook’s **Find ebook** dialog links the file to that work.

Ebooks are checksum-verified, saved under `MEDIA_ROOT/ebooks`, and downloadable from the ebook shelf. “Find ebook” on an audiobook links the chosen edition to the same work. Ebook editions are independent of audiobook editions and recordings. EPUBs open directly in the built-in reader; PDFs remain available to download for an external reader. See the reading-sync workflow below.

## Appearance and built-in EPUB reader

Settings → **Appearance** previews Forest, Charcoal, AMOLED, High contrast, Light and System themes. Customize the accent, palette, interface font, text size and spacing. Save account defaults or select **Use these settings only on this device**. JSON import/export accepts validated settings; browser chrome and offline reload use the cached theme.

Linked EPUBs appear inside **Now Playing** alongside the title, playback options, audiobook seek bar, playback controls and sleep timer; standalone EPUBs open from Discover → Ebooks. The player’s ebook icon opens the saved position without starting playback. In Page mode, tap the left or right edge or swipe to turn pages; tap the centre to show controls, and swipe down from the top to close. The footer also opens the controls. Long-press a sentence for listening, bookmarking, copying, or opening it in Lyrics. The bottom controls include **Read from audio** and **Listen from here** for moving between listening and reading positions, book progress, contents, playback, bookmarks and the Page/Lyrics switch. Search, appearance, saved bookmarks, reading sync and offline saving are available in the top controls. Desktop readers have a contents sidebar, page arrows and keyboard navigation.

Lyrics mode displays sentence lines, follows a prepared recording map and seeks when a line is tapped. Scrolling manually pauses following; **Back to narration** resumes it. Without a map, the text remains readable and offers a link to prepare sync. Sentence and split-line timing is estimated until the alignment is reviewed. Text size remains adjustable. Reading checkpoints use CFIs and sentence locators rather than display page numbers. Offline positions and bookmark changes queue locally and retry when connected; conflicting sessions offer both positions. EPUB scripts and remote embedded resources are blocked.

## Local ebook/audio synchronization

1. Import a matching EPUB through an audiobook’s **Find ebook** dialog, or explicitly link it to the desired book in the reader’s **Reading sync** panel.
2. Choose the exact audiobook release. A clear language mismatch is refused. Match ebook sections to tracks/embedded chapters; edit their start and length to exclude introductions or split a long physical file. Each processing section is limited to two hours.
3. Select **Prepare reading sync**. Audio is first saved to the server HDD when needed. One CPU worker processes the supplied text locally; a short independent speech excerpt checks for gross mismatches. Jobs persist in SQLite and pause, cancel or resume at section boundaries. Completed section outputs are cached on the HDD.
   A release that is one audio file without chapter markers (or several files with none that match) is prepared without a chapter matcher. Sonder takes 30-second speech samples about every ten minutes, more densely near the start and end. It looks for each one in the EPUB, keeps samples that move forward through the book, and rejects repeated-phrase outliers. Where the gap between samples disagrees with the text length, it adds samples between them. Known-text alignment then runs on each window between samples, with overlapping edges, one window at a time. Intro and closing credits, ebook text with no narration, narration not in the ebook, and unaligned windows are listed in the sync status and left unsynced. If too few samples match, the EPUB is refused as a different edition. Sampling and windows resume after a pause. Selecting chapters manually in the matcher uses the chapter workflow instead.
4. **Read from audio** moves the ebook to the current audiobook position; **Listen from here** seeks the selected release to the current ebook passage. These controls are in the reader controls, and **Listen from here** is also in the sentence sheet. **Back to narration** resumes automatic following. Optional follow-along highlights narration without writing new reading events.
5. Timings start as **estimated**, with unmapped passages left unsynced. Preview passages before **Mark alignment reviewed**. While that recording is selected, the sync panel also offers manual sentence start/end corrections. A replaced EPUB or changed audio file invalidates its map.

The separate worker is limited to two CPUs and 6 GB RAM, exposed only on loopback and protected by a private token. All models, temporary audio and analysis stay under `MEDIA_ROOT/alignment`; the default tiny model is pinned and downloaded explicitly with `download_model.py`. Ordinary processing uses cached weights with networking disabled at the model loader. No paid API is called and user audio is not uploaded. Reading again uses the cached map, with no inference charge. See [the measured local benchmark and limits](docs/ALIGNMENT_BENCHMARK.md).

In Hardcover two-way mode, deliberate EPUB reading publishes overall page progress (or an audio fraction if no pages are available), including books without local audio. This has its own durable retry queue. Precise CFIs and timings remain in Sonder, and reader updates do not overwrite a recording’s listening checkpoint. Incoming coarse Hardcover progress does not replace a precise EPUB checkpoint.

## Storage and security

- `data/sonder.db`: canonical library, recordings, tracks, download jobs, encrypted integration settings, and independent ebook editions.
- `data/.encryption-key`: generated AES-256-GCM key. Back it up with the database; losing it makes saved integration credentials unreadable.
- `MEDIA_ROOT/complete` and `incomplete`: local torrents, both mounted into Transmission as `/downloads`.
- `MEDIA_ROOT/alignment`: pinned speech models, temporary decoded audio, section results and alignment maps.
- `MEDIA_ROOT/imports`, `saved`, `ebooks`, and `demo`: imported audio, permanent stream copies, ebook files, and the included Alice sample.
- Session tokens are hashed in SQLite and use HTTP-only, SameSite=Strict cookies. Set `APP_PASSWORD` for sign-in. Cross-origin API writes are rejected.
- TorBox API keys and permanent authenticated link parameters never reach the browser. Signed links are resolved server-side. Media proxies accept only stored source records, not arbitrary URLs.
- Downloaded browser files are local device storage and are not encrypted. Signing out gates their access through the app and clears the bounded streaming cache.

App shell and bundled fonts are precached after a production build. If the installed app behaves unexpectedly, Settings → **This device → Reset app on this device** checks the connection, clears Sonder’s app and streaming caches, unregisters its service worker, and reloads. Device downloads, local settings, and unsynced progress are kept. Device downloads use bounded 4 MiB requests, retry interrupted sections and persist verified chunks in IndexedDB so they can resume after reload. Only complete files become offline downloads; previous OPFS and Blob downloads remain readable. A source without range support can still download, but must restart its transfer after an interruption. The audio proxy limits connection setup rather than imposing a two-minute deadline on an entire audiobook. Open the expanded player for **Save on device**, **Pause download**, **Resume download**, download management and book editions.

A separate streaming cache retains at most 24 exact request segments, each at most 4 MiB, and is never labeled as an explicit download. Full local files support suffix, bounded, and open byte ranges plus HEAD and 416 responses. Service workers also serve byte ranges from complete browser downloads.

The compact and expanded player show **TorBox**, **Host server**, **Device cache**, or **Online stream** for other upstream services. This describes the serving path: a verified HDD copy of a TorBox track reports Host server, and offline files or cached streaming sections report Device cache.

Browser storage can be evicted. Sonder requests persistent storage and reports whether it was granted. iOS background playback/download limits depend on browser and OS; locked-screen behavior still needs physical iOS/Android verification. Signed TorBox URLs and streaming fragments do not constitute an offline book.

## Verify

```bash
npm test
npm run build
npm run test:browser
```

Browser tests use a temporary isolated database and media directory. They verify mobile navigation, real audio playback, progress after reload, file import, complete offline download, service-worker range responses, and offline relaunch. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when using an existing Chromium installation. Unit/integration tests cover media ranges, authentication, secret storage, conflict reconciliation, source parsing, cache-hit routing, and local torrent completion. Live paid integrations require your own credentials; upstream mirrors can be unavailable or require browser verification.

`node --import tsx scripts/verify-playback-workflow.mjs recording-id` checks the deployed UI with real audio, embedded chapter seeking, precision drags, mobile/desktop widths, available original/server sources, reader shortcuts and canonical Hardcover links. Its fresh browser uses device-only preferences and intercepts its own audio/reader checkpoint writes, preserving the listener’s canonical progress. Results and screenshots are written under `artifacts/`. Fault flags and copy removal are exercised against isolated media in the browser/API tests. `node scripts/verify-integrated-reader.mjs recording-id` verifies inline reading, automatic passage highlighting, the long-press sentence sheet, Lyrics mode following and tap-to-seek, and mobile/desktop layouts against an existing prepared map. It also isolates preferences and intercepts progress writes in its QA browser; results are saved to `artifacts/integrated-reader-verification.json`.

Demo recordings come from LibriVox/Internet Archive; the first Alice chapter is bundled so the initial player works immediately. Other chapters stream through the server. See `server/catalog.json` and [third-party notices](THIRD_PARTY_NOTICES.md). The covers and mark are original SVG illustrations.
