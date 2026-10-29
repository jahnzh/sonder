# Android Emulator on the Steam Deck

Mobile specs in real Chrome and Firefox for Android (issue #66, part of #30). Facts verified on 2026-10-29.

## Running

```bash
npm run build          # the browser server serves dist/
npm run test:android   # both browsers; or: bash scripts/test-android-emulator.sh chrome
```

`scripts/test-android-emulator.sh` boots the emulator, opens one SSH connection with the tunnels, runs `playwright.android.config.ts` once per browser, then closes the tunnels and stops the emulator. It runs `now-playing-layout` and `device-reset`; add a spec by importing `test` from `tests/e2e/fixtures.ts` and adding it to the config's `testMatch`. It is not part of `npm run test:browser` or `npm run check`.

Results go to `artifacts/android-emulator/<sha>/<run>/`: `summary.txt` (per-browser result), `emulator.txt` (boot seconds, memory after boot and after the tests), `deck-after.txt` (the Deck after cleanup), and per browser `report.json`, `playwright.log`, `test-results/` and, for Firefox, `relay.log`.

`scripts/emulator-deck.sh start|stop|status|install-apk <apk>|install-firefox|adb <args>` manages the emulator by hand. Exit codes and environment variables are in the header of each script.

## Host and layout

- `deck@steamdeck`, rootless Podman, no `sudo`, `/dev/kvm` world read-write. Lingering is on, so the emulator runs as the transient user unit `sonder-emu-<name>` (default `sonder-emu-android34`) around a container of the same name.
- Everything lives in `~/sonder-emu/`: `downloads/` (zips and the APK, checksummed), `sdk/` (emulator 37.2.12, platform-tools 37.0.1, `system-images;android-34;google_apis;x86_64` r14), `avd/`, `state/` (unit wrapper, log, boot time). About 9.5 GB.
- Image: the CI image `mcr.microsoft.com/playwright:v1.64.1-noble`, reused for its X/GL libraries; the SDK is mounted at `/emu`. Nothing else is installed on the Deck.
- The SDK packages come straight from `dl.google.com` with the SHA-1 published in Google's repository manifests, without `sdkmanager` or Java. Their licence is the Android SDK License; the Google APIs image includes Chrome (113.0.5672.136).
- Firefox for Android is `fenix-159.0.multi.android-x86_64.apk` from `archive.mozilla.org` (package `org.mozilla.firefox`), pinned by SHA-256. Its v2 signature was verified with `apksigner` 37: signer `CN=Release Engineering, O=Mozilla Corporation`, certificate SHA-256 `a78b62a5…ea319b04`. To move to another release, verify the new APK with `apksigner verify --print-certs` and update the pin in `scripts/emulator-deck.sh`.

## Resources

- `start` refuses while a `sonder-ci-run-*` container or unit is active. A CI run uses `--memory 6g`, so never run both. `ci-deck.sh` does not check for the emulator: stop it (`scripts/emulator-deck.sh stop`) before dispatching CI.
- Container limit `--memory 4600m --cpus 4`. Measured: cold boot 39–42 s with `-wipe-data`; anon memory about 3.4 GB after boot and up to about 4.0 GB after a browser run, plus page cache the kernel reclaims under the limit.
- The emulator raises the RAM of this image to 2560 MB whatever `hw.ramSize` or `-memory` say.

## How the browsers are driven

- **Network.** The adb server runs in the container on the Deck's `127.0.0.1:5037`. The SSH connection forwards it to `SONDER_ANDROID_ADB_PORT` (15037) here and sends the Deck's app port back to `tests/browser-server.ts` here. `adb reverse` makes the emulator's `127.0.0.1:<port>` that server. The page is on `127.0.0.1`, a secure context, so its service worker registers, which `10.0.2.2` would not give. The app never reaches `sonder.pecori.no`.
- **Chrome**: Playwright `_android` (`launchBrowser`) over the forwarded adb server, after `pm clear` for a fresh profile per test.
- **Firefox**: Playwright's WebDriver BiDi backend (`firefox` with `channel: "moz-firefox"`) with `tests/android/firefox-bidi-launcher.mjs` as the executable. The launcher writes a GeckoView config (`--remote-debugging-port`), sets Firefox as the debug app, starts it with the `performancetest` extra (skips onboarding), and relays BiDi. The relay's changes, all logged to `relay.log`, are documented in `BidiRelay` in `tests/android/firefox-android.mjs`.
- **Viewport.** Neither browser emulates a viewport on Android, so `page.setViewportSize` resizes the screen with `wm size` until the CSS viewport matches (`tests/android/fixtures.ts`). Chrome's toolbars take 80 CSS px of height, Firefox's 88.

## Firefox automation paths (evidence, 2026-10-29)

1. **geckodriver 0.37.1 with `moz:firefoxOptions.androidPackage`** (WebDriver classic) works after two fixes: `--android-storage internal` (the default `/sdcard` push fails with `fchown failed: Operation not permitted`) and `androidIntentArguments` with a VIEW intent to an http URL plus `--ez performancetest true` (without a tab the session waits forever on "Waiting for initial application window"). Navigation and scripts work, but it cannot run Playwright specs, and `setWindowRect` answers "Only supported in desktop applications".
2. **WebDriver BiDi** works directly, without geckodriver. This is the path the specs use, through Playwright's BiDi backend. No Playwright fork is needed.
3. **Marionette** is what geckodriver uses in path 1; it was not driven separately.

## Failure modes

- **Port 4190 or another Fetch-blocked port**: Firefox shows "Port restricted for security reasons". The default app port is 4174.
- **Remote agent answers 400 to everything**: the Host header port differs from the agent's own port. The BiDi port is the same number on the device, the Deck and here.
- **`Running multiple emulators with the same AVD`**: lock files left by a force-removed container. `start` clears them.
- **`cmd: Can't find service: activity`**: Android's system server died. Seen when Firefox's GPU process hung on SwiftShader during a resize; the launcher's `EMULATOR_PREFS` keep Firefox rendering in software. Stop and start the emulator.
- **A Firefox page that never becomes stable or resizes**: the same GPU-process cause; check `relay.log` and `adb logcat` for `Killing GPU process`.
- **The emulator log**: `~/sonder-emu/state/<name>.log` on the Deck.
