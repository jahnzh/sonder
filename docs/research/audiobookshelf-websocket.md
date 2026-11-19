# Audiobookshelf's websocket, and what Sonder needs

The owner asked: what does the websocket in Audiobookshelf do, would it be good in Sonder, and is there something simpler that gets the same result with fewer complications?

**Short answer.** Audiobookshelf (ABS) uses one socket.io connection per open client. The server pushes "this changed" events to it: library items, the user's progress, playlists, background tasks. Its own mobile app still does a visibility-based refetch on top of the socket, because a phone's socket is dead while the app is in the background. Sonder already does most of that: it polls with `ETag`, reads again on `visibilitychange`/`online`, and polls faster while something is moving. A socket would fix one real gap, and so would a much smaller change: a paused player on one device does not pick up a newer position saved on another device, and pressing play there overwrites that position (§3.1). **Recommendation: don't add a websocket or SSE. When the player is paused and comes back into view, or play is pressed after a pause, refresh that recording's progress.** The ABS mobile app does the same thing in `deviceFocused` (§1.4). A ticket outline is in §6.

Sources are pinned. ABS server and web client: tag [`v2.38.0`](https://github.com/advplyr/audiobookshelf/tree/v2.38.0) (commit `1430c9f`). ABS mobile app: tag [`v0.14.2-beta`](https://github.com/advplyr/audiobookshelf-app/tree/v0.14.2-beta) (commit `7014e04`). ABS API docs: commit [`a62c7f9`](https://github.com/audiobookshelf/audiobookshelf-api-docs/tree/a62c7f9d2800d80a16030c3d45f58fe4d09feeee). Caddy: [`v2.11.7`](https://github.com/caddyserver/caddy/tree/v2.11.7), the version on this server (`caddy version`). Sonder references are repo paths at `b4284d6`.

---

## 1. What the Audiobookshelf socket does

### 1.1 The server: `SocketAuthority`

- It is socket.io (`require('socket.io')`), attached to the main HTTP server at `/socket.io`. When a router base path is set, a second server is added at `<base>/socket.io` "for legacy clients" ([SocketAuthority.js#L1](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L1), [#L154-L174](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L154-L174)). It depends on `socket.io ^4.5.4` ([package.json#L59](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/package.json#L59)).
- **Authentication happens in a separate message after the connection is open.** A new socket starts with no user. The client emits `auth` with its JWT or API key. The server validates it, attaches the user and replies `init`, or `auth_failed` if it fails ([#L177-L188](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L177-L188), [#L269-L362](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L269-L362)). The docs note that after a reconnect, the socket "will have a new socket ID and will need to authenticate again" ([_socket.md#L7-L9](https://github.com/audiobookshelf/audiobookshelf-api-docs/blob/a62c7f9d2800d80a16030c3d45f58fe4d09feeee/source/includes/_socket.md#L7-L9)). The web client sends `auth` again after a token refresh ([client/layouts/default.vue#L85-L89](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/client/layouts/default.vue#L85-L89)).
- **Four ways to fan out an event** ([#L57-L131](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L57-L131)):
  - `emitter`: every authenticated socket, with an optional user filter.
  - `clientEmitter(userId)`: every socket of one user, i.e. all of that user's devices.
  - `adminEmitter`: admins only.
  - `libraryItemEmitter` / `libraryItemsEmitter`: only users who can access the item. The full expanded item JSON is sent, not just an id.
- **Events the client sends** ([#L188-L254](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L188-L254)): `auth`, `cancel_scan` (admin), `search_covers` / `cancel_cover_search` (streamed cover search results), `set_log_listener` / `remove_log_listener` (admin live log), `message_all_users` (admin toast), `ping`.
- **Presence**: `user_online` / `user_offline` go to admins when a user's socket authenticates or drops ([#L224](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L224), [#L348](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L348)).
- Liveness comes from socket.io itself. Engine.io's defaults are `pingInterval: 25000` and `pingTimeout: 20000` ([engine.io server.ts#L196-L197](https://github.com/socketio/socket.io/blob/engine.io@6.6.9/packages/engine.io/lib/server.ts#L196-L197)). So every open client sends a heartbeat frame every 25 s.

### 1.2 What the server emits (v2.38.0)

From grepping every `SocketAuthority.*Emitter('…')` call in `server/`, grouped by purpose:

| Group | Events | Sent to | Example source |
|---|---|---|---|
| **Your progress** | `user_item_progress_updated` (`{id, sessionId, deviceDescription, data: MediaProgress}`) | the user's own sockets | [PlaybackSessionManager.js#L402-L407](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/managers/PlaybackSessionManager.js#L402-L407) (`syncSession`, the periodic sync of a streaming session), [#L265-L270](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/managers/PlaybackSessionManager.js#L265-L270) (`syncLocalSession`, offline sessions uploaded later) |
| | `user_updated` (the whole user object) | the user's own sockets | `PATCH /api/me/progress/:id` emits `user_updated`, **not** `user_item_progress_updated` ([MeController.js#L274-L288](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/controllers/MeController.js#L274-L288)); bookmarks and settings also use it (`MeController.js` L264–L584) |
| | `user_session_closed` | the user's own sockets | [PlaybackSessionManager.js#L429](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/managers/PlaybackSessionManager.js#L429) |
| **Library contents** | `item_added`, `item_updated`, `item_removed`, `items_added`, `items_updated` | users with access | e.g. [LibraryScanner.js#L648](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/scanner/LibraryScanner.js#L648), [ApiRouter.js#L404](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/routers/ApiRouter.js#L404); `item_updated` is emitted from about 20 places (metadata edits, cover changes, scans, podcast episodes) |
| | `library_added/updated/removed`, `author_*`, `series_*`, `authors_num_books_updated` | everyone | [LibraryController.js#L171](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/controllers/LibraryController.js#L171), [Scanner.js#L316](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/scanner/Scanner.js#L316) |
| **User's own lists** | `playlist_*`, `collection_*` | the user's own sockets | [PlaylistController.js#L118](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/controllers/PlaylistController.js#L118), [CollectionController.js#L100](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/controllers/CollectionController.js#L100) |
| **Background work** | `task_started`, `task_finished` (everyone); `task_progress`, `track_started/progress/finished`, `metadata_embed_queue_update` (admins) | | [TaskManager.js#L24](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/managers/TaskManager.js#L24), [AbMergeManager.js#L145-L150](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/managers/AbMergeManager.js#L145-L150) |
| | `episode_download_queued/started/finished`, `episode_added`, `episode_download_queue_cleared` | everyone | [PodcastManager.js#L85-L256](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/managers/PodcastManager.js#L85) |
| **Server-side HLS transcoding** | `stream_open/ready/progress/reset/error/closed` | the user's own sockets | [objects/Stream.js#L417](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/objects/Stream.js#L417), [HlsRouter.js#L87](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/routers/HlsRouter.js#L87) |
| **Admin / multi-user** | `user_online/offline`, `user_added/removed`, `user_stream_update`, `share_open/closed`, `rss_feed_open/closed`, `notifications_updated`, `backup_applied`, `custom_metadata_provider_*`, `admin_message` | admins / everyone | [PlaybackSessionManager.js#L361](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/managers/PlaybackSessionManager.js#L361), [ShareManager.js#L142](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/managers/ShareManager.js#L142) |
| **Request/response over the socket** | `cover_search_result/complete/error/provider_error/cancelled`, `batch_quickmatch_complete`, `pong`, `log` | the requesting socket | [SocketAuthority.js#L374-L451](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L374-L451), [LibraryItemController.js#L811](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/controllers/LibraryItemController.js#L811) |

The API docs list the same groups ([_socket.md](https://github.com/audiobookshelf/audiobookshelf-api-docs/blob/a62c7f9d2800d80a16030c3d45f58fe4d09feeee/source/includes/_socket.md); e.g. `user_item_progress_updated` at [L71](https://github.com/audiobookshelf/audiobookshelf-api-docs/blob/a62c7f9d2800d80a16030c3d45f58fe4d09feeee/source/includes/_socket.md#L71)). They have drifted from the code, though. They document a `fetch_daily_logs` client event and an `invalid_token` reply ([L41-L45](https://github.com/audiobookshelf/audiobookshelf-api-docs/blob/a62c7f9d2800d80a16030c3d45f58fe4d09feeee/source/includes/_socket.md#L41-L45), [L406](https://github.com/audiobookshelf/audiobookshelf-api-docs/blob/a62c7f9d2800d80a16030c3d45f58fe4d09feeee/source/includes/_socket.md#L406)). v2.38.0 handles neither and sends `auth_failed` instead ([SocketAuthority.js#L277](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/server/SocketAuthority.js#L277)). A hand-maintained event contract going stale is one of the costs of this design.

### 1.3 The web client

- It connects with `nuxt-socket-io`, `transports: ['websocket']` (no long-polling fallback) and `reconnection: true`, and registers about 45 handlers ([client/layouts/default.vue#L382-L479](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/client/layouts/default.vue#L382-L479)).
- It shows toasts for "socket connected / failed / disconnected" ([#L91-L130](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/client/layouts/default.vue#L91-L130)), so the connection state is visible UI.
- `user_item_progress_updated` only replaces the entry in the Vuex `mediaProgress` list, which drives the progress bars ([default.vue#L293-L294](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/client/layouts/default.vue#L293-L294), [store/user.js#L185-L197](https://github.com/advplyr/audiobookshelf/blob/v2.38.0/client/store/user.js#L185-L197)). **The web player is not moved.**

### 1.4 The mobile app (the client closest to Sonder)

- It uses `socket.io-client` with `transports: ['websocket']` and `reconnectionDelayMax: 15000` ([plugins/server.js#L34-L42](https://github.com/advplyr/audiobookshelf-app/blob/v0.14.2-beta/plugins/server.js#L34-L42)). It listens to only five server events: `init`, `auth_failed`, `user_updated`, `user_item_progress_updated`, `playlist_added` ([#L52-L61](https://github.com/advplyr/audiobookshelf-app/blob/v0.14.2-beta/plugins/server.js#L52-L61)).
- On `user_item_progress_updated` ([layouts/default.vue#L259-L324](https://github.com/advplyr/audiobookshelf-app/blob/v0.14.2-beta/layouts/default.vue#L259-L324)):
  1. If that item is open in the player, **paused**, and the update came from another session, it seeks the player to the new `currentTime` ([#L266-L270](https://github.com/advplyr/audiobookshelf-app/blob/v0.14.2-beta/layouts/default.vue#L266-L270) → [AudioPlayerContainer.vue#L306-L308](https://github.com/advplyr/audiobookshelf-app/blob/v0.14.2-beta/components/app/AudioPlayerContainer.vue#L306-L308)).
  2. If the server's `lastUpdate` is newer than the downloaded copy's local progress, it overwrites the local progress. This is last-writer-wins by timestamp ([#L276-L291](https://github.com/advplyr/audiobookshelf-app/blob/v0.14.2-beta/layouts/default.vue#L276-L291)).
- **It does not rely on the socket alone.** On `visibilitychange` it reloads local progress if the app was hidden for more than 30 s, then emits `device-focus-update` ([layouts/default.vue#L326-L344](https://github.com/advplyr/audiobookshelf-app/blob/v0.14.2-beta/layouts/default.vue#L326-L344)). `deviceFocused` does nothing while playing. While paused it fetches the server progress for the open item and seeks if the difference is more than 1 s ([AudioPlayerContainer.vue#L405-L436](https://github.com/advplyr/audiobookshelf-app/blob/v0.14.2-beta/components/app/AudioPlayerContainer.vue#L405-L436)). After a socket reconnect it re-checks the same thing ([#L386-L400](https://github.com/advplyr/audiobookshelf-app/blob/v0.14.2-beta/components/app/AudioPlayerContainer.vue#L386-L400)).

So even ABS treats the socket as a fast path. The correctness net for "progress moved on another device" is a refetch on focus or reconnect.

---

## 2. What Sonder does today for the same needs

Sonder has no socket or SSE anywhere. `ws` is a dev dependency used only by the Android/Firefox test launcher (`package.json:65`, `tests/android/firefox-bidi-launcher.mjs`). Everything is pull: timers that pause when the tab is hidden, plus re-reads on `visibilitychange`, `online` and in-app events.

| Need | What Sonder does | Where |
|---|---|---|
| **Progress write** | Saved to Dexie first with `pending: true`, then `syncProgress()` drains pending rows to `POST /api/progress`. The server keeps the newer `updatedAt` and answers `{progress, conflict: true}` for an older write. | `src/lib.ts:345-376`, `server/app.ts:450-482` |
| **Progress read** | `loadBooks()` fetches `/api/books` and keeps whichever of server and local progress is newer. It runs on app start, on `visibilitychange` → visible, and after library changes. | `src/lib.ts:377-400`, `src/App.tsx:495-510` |
| **Library** | `GET /api/library` with `ETag` / `If-None-Match` (304 when unchanged). Re-read on foreground, `online`, `sonder:library-changed`, and **every 6 s while a work is "moving"** (queued acquisition, copy to server, running reading sync). | `src/library-works-store.ts:173-188`, `src/library-works-overlay.ts:68`, `server/library-works.ts:668-669`, README "Listening workflow" |
| **Activity / Now** | `GET /api/activity` every **15 s** while Now is shown, otherwise every **60 s**. Skipped while hidden, re-read on visible and `online`. The Activity page itself polls every 15 s while visible. Each read runs the service probes with a 4 s cap. | `src/App.tsx:154-202`, `src/pages/activity-server.tsx:27,196`, `server/activity.ts:197-215` |
| **Reading sync job** | Polls the job every **4 s** while the page is visible. | `src/pages/reading-sync-page.tsx:48,97-106` |
| **Series add / save** | **2.5 s** while a saved book is queued, **5 s** offline retry. | `src/pages/series-page.tsx:43-46,209-215` |
| **Settings batch** | **2 s** while a batch runs. | `src/pages/settings/server.tsx:243` |
| **Torrent health** | **60 s**. | `src/components/TorrentHealth.tsx:5,27-29` |
| **Connection line** | `/api/health` every **10 s**, only while a request has failed but the browser says it is online. | `src/shell.tsx:79-92` |
| **App update** | `fetch("/build.json", {cache: "no-store"})` once a minute and on `focus`, `online` and `visibilitychange`. Skipped while hidden or offline. | `src/app-update.ts:21-43` |
| **Keep on this device** | Runs on visible, `resume`, `pageshow`, `online` and library-stored events. | `src/keep-runtime.ts:198-218` |

The service worker passes `/api/*` straight to the network without `respondWith` (`public/sw.js:232-233`), except `/api/media/:id` byte ranges. Caddy does `encode zstd gzip` and then `reverse_proxy 127.0.0.1:3001` (`deploy/audiobooks.caddy`).

---

## 3. Which ABS events would fix a real gap in Sonder

### 3.1 Real gap: a paused player keeps a stale position, and resuming overwrites the newer one

From reading the code (not reproduced in the live UI):

1. The phone is paused at 1:00:00 in recording R. The owner listens on the laptop to 2:00:00, and the laptop saves that.
2. The phone comes back into view. `loadBooks()` refreshes the library rows (`src/App.tsx:495-510`), but nothing moves the loaded `<audio>` element.
3. Pressing play calls `toggle()`, which resumes with `playRef.current(book, track, pendingSeek ?? elementPlace())`, an explicit start at the element's own place, 1:00:00 (`src/player.tsx:775-786`). The saved progress is only compared when no start is given (`src/player.tsx:395-403`).
4. The next `persist()` stamps that position with `progressClock(…, Date.now(), book.progress?.updatedAt)`, which is always newer (`src/player.tsx:233-249`, `src/progress-clock.ts:2-8`). The server keeps the newer timestamp (`server/app.ts:481-482`), so **the laptop's 2:00:00 is overwritten**. The laptop's place survives only in that device's position history.

This is exactly the case ABS's mobile app handles twice, once with the socket event while paused and once with the focus refetch (§1.4). It is the one ABS socket behaviour worth copying. It does not need a socket. The ABS app's own fallback, "on focus, while paused, fetch server progress for the open item and seek if it differs", fixes it on its own, because the phone cannot play without first being in view or getting a Media Session command.

One gap would remain: **play pressed from the lock screen or headphones** without the app coming into view. The Media Session `play` handler calls `el.play()` directly (`src/player.tsx` Media Session block). A check before resuming (fetch with a short timeout, then fall back to the local place) covers that. A socket would not help here either: a backgrounded phone's socket has usually been dropped.

### 3.2 Partial gap: Activity freshness

Now/Activity are at most 15 s stale while visible, and fresh on return. A push would make a finished download or alignment show up in under a second instead of within 15 s. For one user who glances at the page, that is cosmetic. The 6 s "moving" poll already keeps the library honest while work runs (§2).

### 3.3 Not a gap for Sonder

- **Library added/removed on another device** (`item_added/removed`): already covered by the `ETag` re-read on foreground. The owner can't look at two screens at once often enough to notice the difference.
- **Presence, user management, shares, RSS, notifications, admin message, live log, HLS `stream_*`** (Sonder serves byte ranges, not server transcodes), **cover search streaming, playlists/collections**: these are multi-user or ABS-specific features with no equivalent in Sonder.
- **Update notice**: `build.json` on focus plus once a minute is already effectively instant at the moment it matters, when the owner opens the app.

---

## 4. Options compared

| | Fixes §3.1 | Complexity | Battery / mobile | Caddy | Service worker | Offline-first fit | Older clients (CLAUDE.md) |
|---|---|---|---|---|---|---|---|
| **WebSocket (socket.io)** | Only while the page is open and the socket is alive; still needs a refetch on focus/reconnect, as ABS does (§1.4) | High: new server dependency, auth on connect, reconnect/backoff, an event contract to keep in sync (ABS's docs drifted, §1.2), connection-state UI | Heartbeat every 25 s per tab ([engine.io defaults](https://github.com/socketio/socket.io/blob/engine.io@6.6.9/packages/engine.io/lib/server.ts#L196-L197)); Android throttles or kills it in the background | Caddy proxies upgrades without extra config ([streaming.go#L60](https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddyhttp/reverseproxy/streaming.go#L60)); deploys drop every socket | Not involved (WS bypasses the SW) | Poor: a second data path next to Dexie and the outbox | Old builds simply don't connect; fine |
| **WebSocket (`ws` / `@fastify/websocket`)** | Same as above | Medium-high: no socket.io dependency, but the reconnect and heartbeat logic has to be hand-written | Same | Same | Same | Same | Same |
| **SSE (`EventSource`)** | Same limits as WS | Medium: one `GET /api/events` with `text/event-stream`, and the browser reconnects automatically. Still a fan-out registry on the server and an event contract. Cookie auth works as-is (same origin) | One idle HTTP connection per tab; same background behaviour as WS | Caddy flushes `text/event-stream` immediately in the proxy ([streaming.go#L282-L284](https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddyhttp/reverseproxy/streaming.go#L282-L284)), and `encode` writes SSE headers straight away ([encode.go#L296-L325](https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddyhttp/encode/encode.go#L296-L325)), but compression of the stream still needs a live check | `/api/*` bypasses the SW (`public/sw.js:232-233`), so no impact | Same as WS | Old builds don't subscribe; fine |
| **Conditional polling (ETag / change counter)** | No, unless the player itself polls while paused | Low; **already in place** for `/api/library` | Already gated on visibility | Nothing new | Nothing new | Good | Good |
| **Long polling** | Like SSE, but worse | Medium | Worse than SSE | Long-held requests | — | — | — |
| **Visibility-based refresh (+ check before resume)** | **Yes**, including lock-screen play if done before resume | **Lowest**: one progress read for one recording at two moments, in `player.tsx` | No background cost; one request on return | Nothing new | Nothing new | Good: falls back to the local place offline; matches "local first, reconcile by timestamp" | Good: can reuse `/api/books` or add a tolerant `GET /api/progress/:recordingId` |
| **Do nothing** | No; the overwrite in §3.1 stays | None | — | — | — | — | — |

---

## 5. Recommendation

**Don't build a websocket or SSE channel.** For a single-user PWA whose main client is a phone that spends most of its time in the background, a push channel only helps while two screens are open at the same moment. ABS itself still needs the focus refetch underneath it to be correct (§1.4). Sonder's existing pull model (ETag, visibility gating, fast polling only while something moves) already covers library, activity and update freshness well enough.

**Build the one thing ABS's socket really fixes:** when the paused player comes back into view, and before a resume from a pause, read the server's progress for the loaded recording. If it is newer than this device's last save and differs by more than a second, move the paused player there instead of resuming from the stale place. That is the ABS mobile app's `deviceFocused` (§1.4), plus a check before resume so lock-screen play is covered.

If Activity freshness ever matters more, the cheap next step is shortening Now's poll while a job runs, not adding a socket. SSE would be the push option to look at if push were ever wanted: same-origin cookie auth, automatic reconnect, `/api/*` already bypasses the SW, and Caddy flushes it.

---

## 6. Ticket-ready outline (not filed)

**Title:** Player: a paused recording picks up a newer position from another device instead of overwriting it

**What.** While a recording is loaded and paused, re-read its server progress when the app comes into view, and again before any resume from a pause (UI play button, Media Session `play`, keyboard). If the server's `updatedAt` is newer than this device's last save for that recording and the place differs by more than 1 s, seek the paused player there (same track or switching track), with no auto-play and the usual "Undo jump". Never move a playing player. Offline, or with no answer within about 1.5 s, resume from the local place as today. Only the loaded recording is compared; progress is never merged across recordings.

**Files.**
- `src/player.tsx`: the `visibilitychange` handler and the resume path in `toggle` / the Media Session `play` handler.
- `src/lib.ts`: a helper that reads one recording's server progress, reusing `/api/books` or a new endpoint.
- Possibly `server/app.ts`: a small `GET /api/progress/:recordingId` that tolerates old clients (purely additive).
- Unit test for the decision function (newer/older/equal/offline/playing). Playwright spec with two browser contexts on one recording: context A paused, context B saves later, A becomes visible or presses play → A lands on B's place and the server keeps B's.

**Acceptance criteria.**
1. Pause on device A, listen further on device B, return to A: A shows B's place before play is pressed. Pressing play continues from there, and the server's progress for that recording is not set back.
2. The same with play pressed from A's lock screen or headphones without opening the app.
3. A playing player is never moved. A paused player whose own save is newer is not moved.
4. Offline or with a slow server, play resumes from the local place immediately (within about 1.5 s); the pending outbox is unchanged.
5. Checked in the real UI with the owner's media on Android/Firefox plus one other browser, using the progress-protecting verify-script rules in CLAUDE.md.
