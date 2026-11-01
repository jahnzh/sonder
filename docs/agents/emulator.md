# Android Emulator on the Steam Deck

Mobile specs in real Chrome and Firefox for Android (issue #66, part of #30). Facts verified on 2026-10-29.

## Running

```bash
npm run build          # the browser server serves dist/
npm run test:android   # both browsers; or: bash scripts/test-android-emulator.sh chrome
```

`scripts/test-android-emulator.sh` boots a fresh emulator for each browser, opens one SSH connection with the tunnels, runs `playwright.android.config.ts` for that browser and stops the emulator again; at the end it closes the tunnels and records what the Deck still runs. It runs `now-playing-layout` and `device-reset`; add a spec by importing `test` from `tests/e2e/fixtures.ts` and adding it to the config's `testMatch`. It is not part of `npm run test:browser` or `npm run check`.

Results go to `artifacts/android-emulator/<sha>/<run>/`: `summary.txt` (per-browser result with `expected`/`unexpected`/`flaky`/`skipped` from each `report.json`, and always `finished_at=`/`exit=` even on early exits), `deck-after.txt` (the Deck after cleanup), and per browser `emulator.txt` (boot seconds, memory after boot and after the run), `report.json`, `playwright.log`, `test-results/`, `logcat.txt` and, for Firefox, `relay.log`. Zero passed tests count as a failure.

`scripts/emulator-deck.sh start|stop|status|install-apk <apk>|install-firefox|adb <args>` manages the emulator by hand. Exit codes and environment variables are in the header of each script. `start` re-checks for a CI run at launch (after setup; remote exit 18 → 8). Preflight image pull and `install-firefox` use `SETUP_TIMEOUT` (1800 s), not the 120 s `CALL_TIMEOUT`.

## Host and layout

- `deck@steamdeck`, rootless Podman, no `sudo`, `/dev/kvm` world read-write. Lingering is on, so the emulator runs as the transient user unit `sonder-emu-<name>` (default `sonder-emu-android34`) around a container of the same name.
- Everything lives in `~/sonder-emu/`: `downloads/` (zips and the APK, checksummed), `sdk/` (emulator 37.2.12, platform-tools 37.0.1, `system-images;android-34;google_apis;x86_64` r14), `avd/`, `state/` (unit wrapper, log, boot time). 8.2 GB idle, about 9.5 GB while the emulator runs.
- Image: the CI image `mcr.microsoft.com/playwright:v1.64.1-noble`, reused for its X/GL libraries; the SDK is mounted at `/emu`. Nothing else is installed on the Deck.
- The SDK packages come straight from `dl.google.com` with the SHA-1 published in Google's repository manifests, without `sdkmanager` or Java. Their licence is the Android SDK License; the Google APIs image includes Chrome (113.0.5672.136).
- Firefox for Android is `fenix-159.0.multi.android-x86_64.apk` from `archive.mozilla.org` (package `org.mozilla.firefox`), pinned by SHA-256. Its v2 signature was verified with `apksigner` 37: signer `CN=Release Engineering, O=Mozilla Corporation`, certificate SHA-256 `a78b62a5…ea319b04`. To move to another release, verify the new APK with `apksigner verify --print-certs` and update the pin in `scripts/emulator-deck.sh`.

## Resources

- `start` refuses while a `sonder-ci-run-*` container or unit is active (checked in preflight and again at launch, since first-time setup can take up to `SETUP_TIMEOUT`). A CI run uses `--memory 6g`, so never run both. `ci-deck.sh` does not check for the emulator: stop it (`scripts/emulator-deck.sh stop`) before dispatching CI.
- Container limit `--memory 4600m --cpus 4` (4.82 GB). Measured: cold boot 39–45 s with `-wipe-data`; anon memory 3.35–3.44 GB after boot, rising to 4.3–4.6 GB by the end of one browser's run, so the container ends each run at its limit. That is why each browser gets its own boot: with both in one boot, Chrome's page closed mid-run ("Target page, context or browser has been closed").
- The emulator raises the RAM of this image to 2560 MB whatever `hw.ramSize` or `-memory` say.
- The Deck backs memory with transparent huge pages (`always`). Disabling them for the emulator (`prctl(PR_SET_THP_DISABLE)`) cut anon memory by about 0.3 GB but made the Chrome run 50% slower and time out; it was dropped.

## How the browsers are driven

- **Network.** The adb server runs in the container on the Deck's `127.0.0.1:5037`. The SSH connection forwards it to `SONDER_ANDROID_ADB_PORT` (15037) here and sends the Deck's app port back to `tests/browser-server.ts` here. `adb reverse` makes the emulator's `127.0.0.1:<port>` that server. The page is on `127.0.0.1`, a secure context, so its service worker registers, which `10.0.2.2` would not give. The app never reaches `sonder.pecori.no`.
- **Chrome**: Playwright `_android` (`launchBrowser`) over the forwarded adb server. Context setup (force-stop, `pm clear` for a fresh profile, and launch) has a bounded retry: by default 3 attempts of 50 seconds each, configurable with `SONDER_ANDROID_CONTEXT_ATTEMPTS` and `SONDER_ANDROID_CONTEXT_ATTEMPT_TIMEOUT_MS`. Both knobs are positive integers and the attempts × timeout product is expected to fit the suite's 180 s fixture timeout. Attempts and their outcomes are logged under `[android-context]` in `playwright.log`. The test body, including assertions, is never retried.
- **Firefox**: Playwright's WebDriver BiDi backend (`firefox` with `channel: "moz-firefox"`) with `tests/android/firefox-bidi-launcher.mjs` as the executable. The launcher writes a GeckoView config (`--remote-debugging-port`), sets Firefox as the debug app, starts it with the `performancetest` extra (skips onboarding), and relays BiDi. The relay's changes, all logged to `relay.log`, are documented in `BidiRelay` in `tests/android/firefox-android.mjs`.
- **Viewport.** Neither browser emulates a viewport on Android, so `page.setViewportSize` resizes the screen with `wm size` until the CSS viewport matches (`tests/android/fixtures.ts`). Chrome's toolbars take 80 CSS px of height, Firefox's 88.

## Firefox automation paths (evidence, 2026-10-29)

1. **geckodriver 0.37.1 with `moz:firefoxOptions.androidPackage`** (WebDriver classic) works after two fixes: `--android-storage internal` (the default `/sdcard` push fails with `fchown failed: Operation not permitted`) and `androidIntentArguments` with a VIEW intent to an http URL plus `--ez performancetest true` (without a tab the session waits forever on "Waiting for initial application window"). Navigation and scripts work, but it cannot run Playwright specs, and `setWindowRect` answers "Only supported in desktop applications".
2. **WebDriver BiDi** works directly, without geckodriver: the GeckoView config starts the remote agent, `adb forward` exposes it, and `session.new` succeeds (`platformName: android`, `browserVersion: 159.0`). This is the path the specs use, through Playwright's BiDi backend.
3. **Marionette over adb port forwarding** works: it is how geckodriver drives path 1 (its log shows `adb forward` to device port 2829 and "Connection to Marionette established"). It was not driven without geckodriver, since paths 1 and 2 cover it.
4. **Playwright**: 1.64.1 has no Firefox-for-Android route of its own (`_android` drives Chrome only; the bundle has no `androidPackage`). Its desktop BiDi backend (`channel: "moz-firefox"`) is what path 2 reuses through the launcher; no fork is needed.

## Measured results (2026-10-29)

The implementer's acceptance run at `ba930ac` passed 11/11 in Chrome and 11/11 in Firefox. Three full runs by the coordinator on the merged code (`e27aad5`, `7db8a00`) did not reproduce that:

| Run | Chrome | Firefox | Failures |
| --- | --- | --- | --- |
| 1 | 10/11 | 10/11 | Chrome `device-reset` offline shell: `Test timeout of 180000ms exceeded while setting up "context"`. Firefox `now-playing-layout` reader-first at 360px. |
| 2 | 9/11 | 10/11 | Chrome reader-first at 390px (`page.goto: Target page, context or browser has been closed`) and the keyboard-focus test (context setup timeout). Firefox: the same 360px test. |
| 3 (Chrome only, `SONDER_EMU_MEMORY=6g`) | 10/11 | not run | Chrome reader-first at 1280px: context setup timeout. |

- **Chrome hangs creating the browser context** in a different test each run (about 1 in 11 to 2 in 11). It is not tied to the memory limit: with 6 GB the emulator still grows to 5.9 GB by the end of a run and the hang still happened, so the default stays at 4600m. The root cause remains open (#71); bounded context-setup retries address the symptom, and the leak-like growth of the emulator's anonymous memory during a run is the lead.
- **Firefox reader-first at 360px failed every time, and was a test assumption (#70, fixed).** The page snapshot showed the transport button labelled `Pause narration`: the tap the test makes on the page starts narration on a real Firefox for Android (it never starts in headless desktop Firefox), and the control toggles between `Play narration` and `Pause narration`. The test now accepts either. Firefox for Android then passed 11/11.
- The scripts do not retry test bodies, although Chrome context fixture setup now retries as described above. A failure is reported as `failed exit=1`; read `playwright.log` and `report.json` before treating a failure as a product bug.
- Boot takes 38 to 45 s. The container ends a run at its memory limit.

## Failure modes

- **Port 4190 or another Fetch-blocked port**: Firefox shows "Port restricted for security reasons". The default app port is 4174.
- **Remote agent answers 400 to everything**: the Host header port differs from the agent's own port. The BiDi port is the same number on the device, the Deck and here.
- **`Running multiple emulators with the same AVD`**: lock files left by a force-removed container. `start` clears them.
- **`cmd: Can't find service: activity`**: Android's system server died. Seen when Firefox's GPU process hung on SwiftShader during a resize; the launcher's `EMULATOR_PREFS` keep Firefox rendering in software. Stop and start the emulator.
- **A Firefox page that never becomes stable or resizes**: the same GPU-process cause; check `relay.log` and `adb logcat` for `Killing GPU process`.
- **The emulator log**: `~/sonder-emu/state/<name>.log` on the Deck.

## Home-screen shortcut and system Back (#85, #84)

`tests/e2e/pwa-shortcut.spec.ts` (Firefox only) drives the real UI with `adb input` and `uiautomator dump` (helpers `androidUiDump`, `androidShell`, `androidScreenshot`, `pressAndroidBack` in `tests/android/fixtures.ts`): menu (three dots, at 672,112) > More > Add to Home screen > ADD > the launcher's "Add to home screen" > Home > tap the Sonder icon > Back twice. Run only it: `SONDER_ANDROID_GREP="home-screen shortcut" bash scripts/test-android-emulator.sh firefox`.

- Firefox for Android 159 on `http://127.0.0.1` offers only **Add to Home screen** (no **Install**). The icon opens the app in a normal Firefox tab (`org.mozilla.fenix.HomeActivity`, address bar visible), not a standalone window. In that tab one Back goes to Firefox's start page (the "Continue: Sonder" tile), a second Back leaves to the launcher. No grey screen reproduced.
- A true installed app needs a secure origin; Firefox then offers **Add app to Home screen** (a phone's newer builds say "Add app to homepage"; the owner's phone shows this for `https://sonder.pecori.no`) and opens a standalone window (`org.mozilla.fenix.customtabs.ExternalAppBrowserActivity`), not a Firefox tab. Reproduce it on the emulator by hand (2026-10-30, #84):
  1. The image is `userdebug`: `scripts/emulator-deck.sh adb root` works.
  2. Make a CA and a `localhost` leaf with `openssl` (leaf needs SAN `DNS:localhost,IP:127.0.0.1`, `extendedKeyUsage=serverAuth`; the CA needs `basicConstraints=CA:TRUE`). Install the CA as a user certificate: `/data/misc/user/0/cacerts-added/$(openssl x509 -subject_hash_old -noout -in ca.pem).0` (mode 644, owner system), writing it with `adb shell "echo <base64> | base64 -d > ..."`.
  3. Tell Firefox to trust it: the GeckoView config (`/data/local/tmp/org.mozilla.firefox-geckoview-config.yaml`, with `am set-debug-app --persistent org.mozilla.firefox`) gets `"security.enterprise_roots.enabled": true` under `prefs:`.
  4. Serve the app over TLS on 4443 (a 20-line `node:https` proxy to the browser-test server) and reach it with `ssh -R 4443:127.0.0.1:4443` plus `emulator-deck.sh adb reverse tcp:4443 tcp:4443`. Open `https://localhost:4443/`, menu > More > Add app to Home screen > the launcher's "Add to home screen" > Home > the icon (allow the notifications prompt).
- **Finding (#84):** in the installed app one system Back from the first page leaves a blank window that stays in focus (empty UI tree, 11 KB screenshot) and a second Back exits to the launcher. A trivial one-page installed app with a manifest, no Sonder code, does exactly the same, so it is Firefox for Android 159's installed-app window, not Sonder. Kill helpers by PID, not `pkill -f`.
- Find nodes by text or content description from the dump, never by fixed coordinates, except the toolbar menu button. Dialog buttons are upper case (`ADD`).
