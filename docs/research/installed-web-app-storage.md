# What an installed iPhone web app may store, and when the browser clears it

Research for issue #464, written 2026-11-16. It feeds the design of "Keep on this device".

Scope: a web app added to the Home Screen on iOS (WebKit), compared with Chrome on Android and Chrome on a desktop. Only primary sources are used: webkit.org, the WebKit and Chromium source, Apple's Safari release notes, MDN and its compatibility data, web.dev, developer.chrome.com, the WHATWG Storage Standard and W3C/WICG specifications. Each claim carries its source and the date or version it applies to.

Versions current when this was written: Safari 27.2, released 2026-10-26, with 27.3 in beta since 2026-11-03 ([Apple release notes](https://developer.apple.com/documentation/safari-release-notes)); Chrome 157 on Android ([caniuse data](https://caniuse.com/netinfo), read 2026-11-16).

Three kinds of evidence appear below, and they are not equally strong:

- **Documented**: a vendor or a standard says it in prose.
- **Source code**: read from the WebKit or Chromium repository on 2026-11-16. It shows what the engine does today. It is not a promise, and it says nothing certain about which shipped version contains it.
- **Inference**: my conclusion from the two above. Always marked.

## Short answers

1. **How much may it store?** On iOS 17 and later, one origin may store up to 60% of the total disk size, and all origins together up to 80%. A Home Screen web app gets these browser figures. Chrome on Android and on a desktop allows the same 60% per origin. These are ceilings worked out from the size of the disk, not from the free space, so the real limit is the free space. A write that does not fit fails with `QuotaExceededError`. The `quota` number from `navigator.storage.estimate()` is deliberately not the real ceiling in either engine.
2. **What does `persist()` grant?** It asks the browser to move the origin's storage from "best-effort" to "persistent". Persistent storage is not cleared by the browser on its own when space runs low; only the user or the site removes it. It returns a promise of `true` or `false`, and `persisted()` reports the current state. Neither Safari nor Chrome shows a prompt. Safari grants it to a site opened as a Home Screen web app. Chrome decides from engagement, installation, bookmarks and notification permission. It raises no quota in Safari or Chrome, and it does not stop the user from clearing the data.
3. **When is data removed?** In a Safari tab, all script-writable storage of a site is deleted after seven days of Safari use without a tap or click on that site. The first-party domain of a Home Screen web app is exempt from that rule. Separately, WebKit evicts whole origins, least recently used first, when total use passes the overall quota or the system is short of space; origins with an open page or in persistent mode are skipped. Chrome has no time rule: it evicts least-recently-used, non-persistent origins when it runs out of space. In every engine an eviction removes all of an origin's data at once, never part of it.
4. **What happens to a running download in the background?** On an iPhone it stops. When the installed app leaves the foreground or the screen locks, the system suspends the page's process, and the service worker's process with it. Safari has no Background Fetch, Background Sync or Periodic Background Sync. Nothing documented keeps a save going. The WebKit source keeps a page's process running while it plays audio, which may carry a save along while a book is playing, but no document promises that. Chrome on Android and on a desktop has the Background Fetch API (since Chrome 74), where the browser itself downloads and carries on after the page closes.
5. **Can a page tell Wi-Fi from mobile data?** Not on an iPhone. Safari does not implement the Network Information API at all. `navigator.connection.type` works only in Chrome on Android (and ChromeOS). Desktop Chrome exposes a speed class, not the kind of connection.

## Detail

### 1. How much IndexedDB may hold

**iOS and Safari (WebKit).** WebKit's storage policy post ([Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/), 2023-08-10) states the rules that apply "Starting in Safari 17.0, and in WebKit apps for iOS 17, iPadOS 17 and macOS Sonoma":

- "For a browser app, the origin quota is up to 60% of the total disk space." "For other apps, the origin quota is up to 15% of the total disk space."
- "For a browser app, overall quota is up to 80% of the total disk space." "For other apps, overall quota is up to 20% of the total disk space."
- "When a web app is running standalone (as Home Screen Web App on iOS or Web App added to dock on macOS), it has the same origin quota and overall quota as when it is opened in a browser app."
- The quota covers "localStorage, Cache API, IndexedDB, Service Worker, and File System". Cookies and the HTTP cache "are currently not subject to the policy".
- When the origin quota is reached, "the storage operation that requires space will fail, and a QuotaExceededError exception will be thrown". Safari 17.0 "no longer prompts users about a website wanting to use more space". Before Safari 17 an origin had 1 GiB and then a prompt ([MDN, Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), modified 2026-01-05).

These figures are still in force. The WebKit source on 2026-11-16 holds the same four ratios (`defaultBrowserOriginQuotaRatio = 0.6`, `defaultBrowserTotalQuotaRatio = 0.8`, `defaultAppOriginQuotaRatio = 0.15`, `defaultAppTotalQuotaRatio = 0.2` in [WebsiteDataStoreCocoa.mm](https://github.com/WebKit/WebKit/blob/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e/Source/WebKit/UIProcess/WebsiteData/Cocoa/WebsiteDataStoreCocoa.mm)) and multiplies the ratio by the volume capacity rounded up to a whole gigabyte (`originQuotaManagerParameters` in [NetworkStorageManager.cpp](https://github.com/WebKit/WebKit/blob/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e/Source/WebKit/NetworkProcess/storage/NetworkStorageManager.cpp)). MDN's page of January 2026 repeats them. Apple's Safari release notes from 17.0 to the 27.3 beta list no later change to the quota; 17.0 is where "Added support for calculating quota based on disk space" appears ([Safari 17 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-17-release-notes), 2023-09-18).

Worked example, by arithmetic: on a 128 GB iPhone the origin ceiling is about 77 GB. The ceiling is a share of the whole disk, so on a nearly full phone the free space runs out long before the quota does. WebKit says so directly: "the quota is an upper limit of how much can be stored — there is no guarantee that a site can store that much, so error handling for QuotaExceededError is necessary."

**Chrome on Android and desktop.** "Chrome allows the browser to use up to 80% of total disk space. An origin can use up to 60% of the total disk space." ([web.dev, Storage for the web](https://web.dev/articles/storage-for-the-web), updated 2024-09-23). The Chromium source gives the working: the pool is 80% of the total disk (`PoolSizeRatio`, [quota_features.cc](https://chromium.googlesource.com/chromium/src/+/main/storage/browser/quota/quota_features.cc)) and one storage key may use 75% of the pool ([quota_settings.cc](https://chromium.googlesource.com/chromium/src/+/main/storage/browser/quota/quota_settings.cc), read 2026-11-16), which is 60%. The calculation has no Android-specific branch. The same file notes that Chrome tries to keep the smaller of 2 GB and 10% of the disk free, and "If there is less than this amount of storage free on the device, Chrome will grant 0 quota to origins." Persistent mode does not change the figure: an origin "can store up to 60% of the total disk size in both persistent and best-effort modes" (MDN, same page).

**What `estimate()` reports.** The Storage Standard ([Living Standard, updated 2026-10-19](https://storage.spec.whatwg.org/)) defines usage as "an implementation-defined rough estimate" and quota as "an implementation-defined conservative estimate", which "must not be a function of the available storage space on the device". Both engines go further and report an artificial quota:

- Chrome, from version 138: "reporting an artificial quota, equal to usage + min(10 GiB, disk rounded up to the nearest 1 GiB)". "Enforced quota will also be unaffected." ([Chrome 138 beta](https://developer.chrome.com/blog/chrome-138-beta), 2025-05-28.) So in Chrome the reported quota never shows more than 10 GiB of headroom.
- WebKit: "to reduce fingerprinting risk introduced by exposing usage and quota, quota might change based on factors like existing usage and site visit frequency" (storage policy post). The source has a separate reported quota that is "at least double existing usage" and never above the real one (`reportedQuota` in [OriginQuotaManager.cpp](https://github.com/WebKit/WebKit/blob/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e/Source/WebKit/NetworkProcess/storage/OriginQuotaManager.cpp)). Whether Safari on iOS turns that on is not visible in the open source.

`usage` is an approximation too: "The returned values are not exact: between compression, deduplication, and obfuscation for security reasons, they will be imprecise" ([MDN, estimate()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate), modified 2026-10-12). `estimate()` exists in Safari from 17.0 and Chrome from 61 ([MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/96b6c5f5fe9771277422b1a4bd433455aceeeae4/api/StorageManager.json), 2026-11-16).

### 2. What `persist()` grants and how a page learns the result

**The standard.** An origin's local storage bucket has a mode, "best-effort" or "persistent", and "It is initially "best-effort"". `persist()` requests the `"persistent-storage"` permission and resolves with `true` if the bucket is persistent afterwards. `persisted()` resolves with `true` if the mode is "persistent"; "It will be false when there's an internal error." The protection is: "The user agent cannot clear storage marked as persistent without involvement from the origin or user." Under storage pressure the browser "should clear network state and local storage buckets whose mode is "best-effort"", and only if pressure continues "should inform the user and offer a way to clear the remaining local storage buckets, i.e., those whose mode is "persistent"" ([Storage Standard](https://storage.spec.whatwg.org/), 2026-10-19). In the interface definition `persist()` is exposed to windows only, while `persisted()` and `estimate()` are also available in workers, so a service worker can read the state but cannot ask for it.

**Safari.** "An origin can check whether storage is in persistent mode with StorageManager.persisted() and request to change the mode to be persistent with StorageManager.persist(). WebKit currently grants a request based on heuristics like whether the website is opened as a Home Screen Web App." ([storage policy post](https://webkit.org/blog/14403/updates-to-storage-policy/), 2023-08-10.) There is no prompt.

The source on 2026-11-16 is more specific (`persist` and `persistOrigin` in [NetworkStorageManager.cpp](https://github.com/WebKit/WebKit/blob/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e/Source/WebKit/NetworkProcess/storage/NetworkStorageManager.cpp), `domainsExemptFromWebsiteDataDeletion` in [ResourceLoadStatisticsStore.cpp](https://github.com/WebKit/WebKit/blob/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e/Source/WebKit/NetworkProcess/Classifier/ResourceLoadStatisticsStore.cpp)):

- The request is granted only when the site's registrable domain is on the list of domains exempt from website data deletion. That list is the Home Screen web app's own domain, app-bound domains, managed domains, and a list handed in by the embedding browser.
- A cross-origin frame is always refused.
- Every call re-checks. If the domain is no longer on the list, the stored marker is deleted and the call returns `false`. So the state can change from `true` to `false` between two starts of the app.

**Chrome.** "Chrome, and most other Chromium-based browsers automatically handle the permission request, and do not show any prompts to the user." It considers: "How high is the level of site engagement?", "Has the site been installed or bookmarked?", "Has the site been granted permission to show notifications?" ([web.dev, Persistent storage](https://web.dev/articles/persistent-storage), last updated 2020-05-12, so old.) MDN's 2026 wording is that Safari and Chromium browsers "automatically approve or deny the request based on the user's history of interaction with the site and do not show any prompts to the user". Firefox asks the user.

**Availability.** `persist()` and `persisted()`: Safari 15.2, Chrome 55, Firefox 57. `estimate()`: Safari 17, Chrome 61 ([MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/96b6c5f5fe9771277422b1a4bd433455aceeeae4/api/StorageManager.json)). All need a secure context ([MDN, persist()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist), modified 2026-10-12).

**What it does not do.** It adds no space in Safari or Chrome (section 1). It does not protect against the user clearing website data. WebKit's own wording about eviction is cautious: an origin "might be excluded from eviction if it has active page at the time of eviction, or its storage is in persistent mode".

### 3. When stored data is removed

**Safari's seven-day cap.** Since iOS and iPadOS 13.4 and Safari 13.1, Intelligent Tracking Prevention has been "deleting all of a website's script-writable storage after seven days of Safari use without user interaction on the site". The forms listed are "Indexed DB", "LocalStorage", "Media keys", "SessionStorage" and "Service Worker registrations and cache" ([Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/), 2020-03-24). "User interaction is a user click, tap, or keyboard entry on a website"; "Scrolling is not considered user interaction" ([Tracking Prevention in WebKit](https://webkit.org/tracking-prevention/), undated reference page, read 2026-11-16). It applies "when cross-site tracking prevention is turned on", and "Cookies set by server are exempt from this eviction" (MDN, 2026-01-05).

**The Home Screen exemption.** Two WebKit statements:

- 2020: "Web applications added to the home screen are not part of Safari and thus have their own counter of days of use. Their days of use will match actual use of the web application which resets the timer. We do not expect the first-party in such a web application to have its website data deleted. If your web application does experience website data deletion, please let us know since we would consider it a serious bug."
- Reference page, current wording: "The first-party domain of home screen web applications is exempt from ITP's 7-day cap on all script-writeable storage, i.e. ITP always skips that domain in its website data removal algorithm. In addition, the website data of home screen web applications is kept isolated from Safari and thus will not be affected by ITP's classification of tracking behavior in Safari."

The source agrees: the standalone application's domain is on the exempt list named in section 2. The exemption is for the app's own first-party domain only.

Since iOS 26 this depends on a choice the user makes when adding the icon: "By default, every website added to the Home Screen opens as a web app. If the user prefers to add a bookmark for their browser, they can disable "Open as Web App" when adding to Home Screen" ([WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), 2025-09-15). Inference: an icon added as a bookmark opens in the browser and is treated like any Safari tab, so the seven-day cap applies and the Home Screen grant of `persist()` does not.

**Eviction by quota or pressure in WebKit.** "Eviction means automatic website data deletion that is not initiated by the user or website. It can happen under a few conditions: when exceeding the overall quota, when the system is under storage pressure, or when the site has not been interacted with by the user for some time". "WebKit normally evicts data on an origin basis: the data of an origin will be deleted as a whole. The ordering of origins to be deleted is decided using a least-recently-used policy. The last use time is the time of the last user interaction, or the time of the last storage operation." "Origin might be excluded from eviction if it has active page at the time of eviction, or its storage is in persistent mode." ([storage policy post](https://webkit.org/blog/14403/updates-to-storage-policy/), 2023-08-10.) The source matches: eviction runs when total use exceeds the overall quota, sorts by last access, and skips origins that are active or persisted (`performQuotaBasedEviction`).

Inference: because a Home Screen web app's data is kept apart from Safari's, the app's own origin is nearly alone in its store, and its 60% origin quota is below the 80% overall quota. Quota-based eviction should therefore be rare for it. This is not a documented guarantee.

Eviction has gone wrong before. Safari 17.4 lists "Fixed cases where website data is unexpectedly evicted" ([Safari 17.4 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-17_4-release-notes), 2024-03-05).

**A newer time rule in the WebKit source.** In May 2026 WebKit added "time-based website data eviction": "For users with ITP disabled, website data can accumulate indefinitely. Add a time-based eviction mechanism that deletes data for origins not accessed within a configurable threshold (default 180 days)" ([commit 312741@main](https://github.com/WebKit/WebKit/commit/4fb2a0985cf0d6956111bf749feaf75118b7f6de), 2026-05-06). In the source on 2026-11-16 it is off unless the app is a browser and tracking prevention is disabled (`timeBasedEvictionMode` in [WebsiteDataStore.cpp](https://github.com/WebKit/WebKit/blob/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e/Source/WebKit/UIProcess/WebsiteData/WebsiteDataStore.cpp)). It checks at most once a week and skips origins that are active, persisted, or hold a push subscription. A build flag decides whether it removes all storage types or only service worker registrations. No Safari release note mentions it, so which version ships it, and in which of the two forms, is not established.

**Chrome.** "Chromium-based browsers will begin to evict data when the browser runs out of space, clearing all site data from the least recently used origin first, then the next, until the browser is no longer over the limit." (web.dev, 2024-09-23.) "This eviction mechanism only applies to origins that are not persistent and skips over origins that have been granted data persistence by using navigator.storage.persist()." Proactive removal of little-used origins "happens only in Safari", and "research from the Chrome team shows that data is very rarely deleted by the browser" (MDN, 2026-01-05). Chrome has no seven-day rule.

**Always the whole origin.** "Whenever a storage bucket is cleared by the user agent, it must be cleared in its entirety." (Storage Standard.) "When an origin's data is evicted by the browser, all of its data, not parts of it, is deleted at the same time." (MDN.) For this app that means the audio chunks, the Dexie tables that describe them, queued progress, the EPUB files and the service worker registration go together. Server-set cookies are outside both WebKit rules, as quoted above.

**The user.** "User agents should offer users the ability to clear network state and storage for individual websites." (Storage Standard.) No mode protects against that.

### 4. A running download when the app goes to the background

The case: a `fetch` whose body is read in the page and written to IndexedDB in 4 MiB chunks.

**iPhone.** Apple and WebKit publish no page that says how long an installed web app keeps running after it leaves the foreground. What can be shown:

- The WebKit source moves a page's process towards suspension once nothing holds it in the foreground: "If the process is currently runnable but will be suspended then first give it a chance to complete what it was doing and clean up - move it to the background and send it a message to notify. Schedule a timeout so it can't stay running in the background for too long." The timeout is 20 seconds (`processSuspensionTimeout` in [ProcessThrottler.cpp](https://github.com/WebKit/WebKit/blob/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e/Source/WebKit/UIProcess/ProcessThrottler.cpp), read 2026-11-16).
- A WebKit commit describes the result for exactly this kind of app: "When a WebContent or service worker process is suspended by the system (for example in an iOS home screen web app), its in-progress IndexedDB transactions are never committed or aborted", and other work queues behind them "until the suspended process is killed, which can take over 30 minutes" ([commit, 2026-06-22](https://github.com/WebKit/WebKit/commit/d910c7f32672e2ddc0a508253c5823f582ef2f00)). The fix aborts such a transaction when it blocks another client, and "a client that later resumes learns about the abort through the stored suspension abort result when it next aborts or commits". A follow-up keeps queued transactions of a suspended client instead of rolling them back ([commit, 2026-08-26](https://github.com/WebKit/WebKit/commit/03efc9761a39b4849f8c849c455b4f6806c250f9)). Safari 27's release notes carry an entry that reads like the same fix: "Fixed an issue where IndexedDB transactions could be blocked for an extended period before starting when another page's transaction was suspended in the background" ([Safari 27 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes), 2026-09-14).

So the service worker is no refuge on iOS: its process is suspended too. Inference: these commits touch only transactions that are in progress, so a chunk whose write had completed stays stored, while the chunk in flight is lost or has its transaction reported as aborted after the app returns. Whether the interrupted `fetch` fails or continues on return is not documented.

What might keep a save going on an iPhone, and what the sources say:

| Mechanism | Safari on iOS | Source |
| --- | --- | --- |
| Background Fetch | Not available. In the source it is a test-only flag, off by default. WebKit has an open standards position request with privacy and maintenance concerns and no decision. | [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/96b6c5f5fe9771277422b1a4bd433455aceeeae4/api/BackgroundFetchManager.json); `BackgroundFetchAPIEnabled` in [UnifiedWebPreferences.yaml](https://github.com/WebKit/WebKit/blob/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml); [standards-positions #149](https://github.com/WebKit/standards-positions/issues/149), opened 2023-03-15 |
| Background Sync, Periodic Background Sync | Not available. WebKit's position on Background Sync is "oppose". | [SyncManager](https://github.com/mdn/browser-compat-data/blob/96b6c5f5fe9771277422b1a4bd433455aceeeae4/api/SyncManager.json), [PeriodicSyncManager](https://github.com/mdn/browser-compat-data/blob/96b6c5f5fe9771277422b1a4bd433455aceeeae4/api/PeriodicSyncManager.json); [standards-positions #14](https://github.com/WebKit/standards-positions/issues/14) |
| Web Push waking the service worker | Each push must show a notification. "The Web Push API is not an invitation for silent background runtime". "Violations of the userVisibleOnly promise will result in a push subscription being revoked." | [Meet Web Push](https://webkit.org/blog/12945/meet-web-push/), 2022-06-07 |
| Screen Wake Lock | Keeps the screen from dimming or locking while the app is visible. In Safari since 16.4; in Home Screen web apps it works from iOS 18.4 ("Fixed Wake Lock API for Home Screen Web Apps"). Released when the document is no longer visible, and the system may refuse it in power save mode or on low battery. It does nothing once the user locks the phone or switches app. | [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/96b6c5f5fe9771277422b1a4bd433455aceeeae4/api/WakeLock.json); [Safari 18.4 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes), 2025-03-31; [MDN, Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API), modified 2026-11-12 |
| Audio playing in the same page | Source code only. WebKit holds the page's process in the foreground while it is audible ("UIProcess is taking a foreground assertion because we are playing audio") and lets go 10 seconds after the audio stops. | `updateThrottleState` in [WebPageProxy.cpp](https://github.com/WebKit/WebKit/blob/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e/Source/WebKit/UIProcess/WebPageProxy.cpp), read 2026-11-16 |

Inference from the last row: while a book is playing, a save running in the same page probably continues with the screen locked, because the process is kept running for the audio. No Apple or WebKit document promises this, and it needs a test on the real phone before anything is built on it.

**Chrome on Android and desktop, without Background Fetch.** A hidden page keeps running until Chrome freezes or discards it. "In the frozen state the browser suspends execution of freezable tasks in the page's task queues until the page is unfrozen. This means things like JavaScript timers and fetch callbacks don't run." "The transition to hidden is also often the last state change that's reliably observable by developers (this is especially true on mobile, as users can close tabs or the browser app itself, and the beforeunload, pagehide, and unload events are not fired in those cases)." ([Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api), updated 2026-10-16). From Chrome 133, with Energy Saver on, Chrome freezes a group of pages when "All pages within the group have been hidden and silent for more than five minutes" and it is CPU-intensive, unless it holds "a Web Lock or an IndexedDB connection that blocks operations outside the group" or does one of a few other listed things ([Freezing on Energy Saver](https://developer.chrome.com/blog/freezing-on-energy-saver), 2025-01-20; the post does not name the platforms). A Chromium document says "Freezing is already enabled on Mobile" ([freezing_opt_out_opt_in.md](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/performance_manager/docs/freezing_opt_out_opt_in.md), undated and visibly old). No official source gives the delay before Chrome on Android freezes a hidden page.

A service worker cannot carry a long download by itself. MDN gives Chrome's limits: it is likely to be stopped if "It has been idle for 30 seconds", "It has been running synchronous JavaScript for 30 seconds", or "The promise passed to `waitUntil()` has taken more than 5 minutes to settle" ([Offline and background operation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation), modified 2026-09-13). The Service Workers specification lets a browser terminate a worker whenever it "Has no event to handle" ([Editor's Draft](https://w3c.github.io/ServiceWorker/), 2026-10-29).

**Chrome with Background Fetch.** "Background Fetch is available by default since Chrome 74." The page hands a list of requests to the browser: "The browser fetches those things, displaying progress to the user." "If the user closes pages to your site after step 1, that's ok, the download will continue." "If the user starts the download while offline, or goes offline during the download, the background fetch will be paused and resumed later." "On some platforms (such as Android) it's possible for the browser to close after step 1". When it ends, the service worker gets an event and must copy the responses somewhere, because "After this event, the fetched requests and responses are no longer accessible". Limits stated there: "Chrome's implementation currently only accepts requests without a body" and it does not "support requests that would require a CORS preflight" ([Introducing Background Fetch](https://developer.chrome.com/blog/background-fetch), last updated 2018-12-03, so old). MDN adds that it "requires the `"background-fetch"` user permission, and the browser displays the ongoing progress of the fetch operation, enabling the user to cancel it" (2026-09-13).

Availability: Chrome 74 on desktop and Android, and Edge; not Firefox, not Safari, not Android WebView ([MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/96b6c5f5fe9771277422b1a4bd433455aceeeae4/api/BackgroundFetchManager.json), 2026-11-16). The specification is a "Draft Community Group Report, 21 April 2021" and "is not a W3C Standard nor is it on the W3C Standards Track" ([Background Fetch](https://wicg.github.io/background-fetch/)). The draft also allows the browser to pause a fetch "if the user is on a metered connection".

### 5. Telling Wi-Fi from mobile data

The Network Information API is the web API for this; I found no other. Its `type` property returns one of "bluetooth", "cellular", "ethernet", "none", "wifi", "wimax", "other", "unknown" ([MDN, NetworkInformation.type](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation/type), modified 2024-03-24).

| Browser | `navigator.connection` | `connection.type` |
| --- | --- | --- |
| Safari on iOS and macOS, to 27.2 | No | No |
| Chrome on Android | Yes, since 38 | Yes, since 38 |
| Chrome on desktop | Yes, since 61 | Only on ChromeOS |
| Android WebView | Yes, since 50 | Yes, since 50 |
| Firefox | No (removed) | No |

Sources: [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/96b6c5f5fe9771277422b1a4bd433455aceeeae4/api/NetworkInformation.json) and [caniuse](https://caniuse.com/netinfo), both read 2026-11-16. caniuse marks desktop Chrome as partial, "Only supports the `downlink`, `effectiveType` & `rtt` values", and lists the specification as unofficial.

Desktop Chrome's `effectiveType` is no substitute. It is "one of slow-2g, 2g, 3g, or 4g", "determined using a combination of recently observed, round-trip time and downlink values" ([MDN, effectiveType](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation/effectiveType), modified 2024-04-01). It measures speed and says nothing about the kind of connection or its cost. `saveData` (Chrome 65 and later, not Safari) reports a user preference for reduced data use.

No source points to the API coming to Safari. MDN labels it "not Baseline because it does not work in some of the most widely-used browsers" ([Network Information API](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API), modified 2025-04-13). Mozilla's position is negative ([standards-positions #117](https://github.com/mozilla/standards-positions/issues/117), closed 2020-04-15), partly because "`downlinkMax` and `type` also expose information that a site cannot measure". WebKit has published no position: its standards-positions repository has no entry for the API (searched 2026-11-16).

## Where the sources disagree or say nothing

- **Safari's quota.** web.dev (2024-09-23) still says "Safari (both desktop and mobile) appears to allow about 1GB". WebKit's own 2023 post and MDN (2026-01) give 60% of disk. The WebKit figure is the one to use; the web.dev line is out of date.
- **The seven-day cap.** web.dev describes it without the Home Screen exemption. WebKit's pages state the exemption, and they own the behaviour.
- **How strong persistent mode is in Safari.** MDN says persistent data "is only evicted, or deleted, if the user chooses to". WebKit says such an origin "might be excluded from eviction". The source skips persisted origins in both eviction paths it contains.
- **Not established: how long an installed web app runs after leaving the foreground.** No Apple or WebKit document gives a time. The 20 seconds above is a constant in the source, not a promise.
- **Not established: whether a save continues behind a locked screen while audio plays.** The source suggests it; nothing documents it.
- **Not established: what an interrupted `fetch` does when the app returns.** No source says whether it rejects or carries on.
- **Not established: what removing the Home Screen icon does to the app's data.** No Apple or WebKit page found says. A dated statement exists only for the other direction: when the icon is created, cookies are copied and "No other kind of local storage is copied over. After a user adds a web app to the Home Screen or Dock, no other website data is shared" ([WebKit Features in Safari 17.2](https://webkit.org/blog/14787/), 2023-12-11).
- **Not established: whether iOS itself removes a web app's data when the phone is nearly full.** WebKit lists "when the system is under storage pressure" as a cause of eviction and gives no detail.
- **Not established: which Safari version contains the 180-day rule**, and the delay before Chrome on Android freezes a hidden page.

## Sources

| Source | Date or version | Used for |
| --- | --- | --- |
| [WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/) | 2023-08-10; Safari 17.0, iOS 17 | Quota, eviction, Storage API, persistent mode |
| [WebKit: Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) | 2020-03-24; iOS 13.4, Safari 13.1 | Seven-day cap, Home Screen note |
| [WebKit: Tracking Prevention in WebKit](https://webkit.org/tracking-prevention/) | Undated reference page, read 2026-11-16 | Seven-day cap, Home Screen exemption, isolation from Safari |
| [WebKit Features in Safari 17.2](https://webkit.org/blog/14787/) | 2023-12-11 | Cookies copied at install, no other data shared |
| [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) | 2025-09-15 | Every Home Screen site opens as a web app by default |
| [WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/) | 2022-06-07 | No silent push |
| [WebKit source](https://github.com/WebKit/WebKit/tree/5a4b3eaa24e9a53279181e1357bd41af90e0ae7e) and the three commits linked above | Revision of 2026-11-16 | Quota ratios, `persist()` logic, eviction, suspension, flags |
| [WebKit standards positions #149](https://github.com/WebKit/standards-positions/issues/149), [#14](https://github.com/WebKit/standards-positions/issues/14) | Read 2026-11-16 | Background Fetch, Background Sync |
| [Apple: Safari release notes](https://developer.apple.com/documentation/safari-release-notes) | 16.4 (2023-03-27) to 27.3 beta (2026-11-03) | Storage API in 17.0, Wake Lock fix in 18.4, eviction fix in 17.4, IndexedDB fix in 27.0 |
| [WHATWG Storage Standard](https://storage.spec.whatwg.org/) | Living Standard, 2026-10-19 | Modes, `persist()`, `persisted()`, `estimate()`, storage pressure |
| [W3C Service Workers](https://w3c.github.io/ServiceWorker/) | Editor's Draft, 2026-10-29 | Service worker lifetime |
| [WICG Background Fetch](https://wicg.github.io/background-fetch/) | Draft Community Group Report, 2021-04-21 | Status, metered connections |
| [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) | Modified 2026-01-05 | Quotas and eviction across browsers |
| [MDN: persist()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist), [estimate()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate) | Modified 2026-10-12 | API behaviour |
| [MDN: Offline and background operation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation) | Modified 2026-09-13 | Service worker limits, Background Fetch, push |
| [MDN: Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) | Modified 2026-11-12 | Wake lock behaviour |
| [MDN: Network Information API](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API), [type](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation/type), [effectiveType](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation/effectiveType) | Modified 2025-04-13, 2024-03-24, 2024-04-01 | Connection type |
| [MDN browser-compat-data](https://github.com/mdn/browser-compat-data/tree/96b6c5f5fe9771277422b1a4bd433455aceeeae4/api) | Revision of 2026-11-16 | Version numbers for every API named here |
| [caniuse: Network Information API](https://caniuse.com/netinfo) | Read 2026-11-16 | Availability table |
| [web.dev: Storage for the web](https://web.dev/articles/storage-for-the-web) | Updated 2024-09-23 | Chrome quota and eviction, `QuotaExceededError` |
| [web.dev: Persistent storage](https://web.dev/articles/persistent-storage) | Updated 2020-05-12, old | Chrome's grounds for granting `persist()` |
| [Chrome: Chrome 138 beta](https://developer.chrome.com/blog/chrome-138-beta) | 2025-05-28 | Artificial reported quota |
| [Chrome: Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) | Updated 2026-10-16 | Hidden, frozen, discarded |
| [Chrome: Freezing on Energy Saver](https://developer.chrome.com/blog/freezing-on-energy-saver) | 2025-01-20; Chrome 133 | Freezing under Energy Saver |
| [Chrome: Introducing Background Fetch](https://developer.chrome.com/blog/background-fetch) | Updated 2018-12-03, old | Background Fetch |
| Chromium source: [quota_settings.cc](https://chromium.googlesource.com/chromium/src/+/main/storage/browser/quota/quota_settings.cc), [quota_features.cc](https://chromium.googlesource.com/chromium/src/+/main/storage/browser/quota/quota_features.cc), [freezing_opt_out_opt_in.md](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/performance_manager/docs/freezing_opt_out_opt_in.md) | Read 2026-11-16 | Quota arithmetic, freezing on mobile |
| [Mozilla standards positions #117](https://github.com/mozilla/standards-positions/issues/117) | Closed 2020-04-15 | Network Information API position |

## What Keep on this device can rely on

On an iPhone, with the app opened from a Home Screen icon added as a web app, on iOS 17 or later:

- The seven-day cap does not apply to the app's own domain.
- The per-origin ceiling is 60% of the disk, the same as in Safari. The free space is the limit that will be met in practice.
- `persist()` shows no prompt and, by WebKit's post and source, is granted to the app's own domain. `persisted()` reports the state that eviction honours. Asking again at every start costs nothing, and the settings screen already shows the result, so the grant can be confirmed on the phone.
- A write that does not fit fails with `QuotaExceededError`. This is the one dependable "storage is full" signal, and `src/media-download.ts` already catches it.
- An eviction takes everything of the origin at once. There is no case where the browser removes one book and leaves the rest, so "did the browser clear my files" is a single cheap check at start.
- A chunk whose IndexedDB write completed is still there after a suspension (inference from the WebKit commits in section 4). Resuming by chunk, as the app does now, matches how the platform behaves.
- Server-set cookies are covered by neither of WebKit's removal rules, so a cookie can still identify the device after the browser has wiped IndexedDB. A user who clears website data removes the cookie as well.
- `visibilitychange` to hidden is the last moment the app is sure to run, and the return to visible is the moment to check and resume.
- While the app is in front, Screen Wake Lock can stop the screen from locking during a save (Home Screen web apps: iOS 18.4 or later).
- `estimate().usage` is good enough to show roughly how much the saved books take.

On Chrome for Android and desktop only: Background Fetch can finish a save after the app is closed, and `connection.type` on Android can tell Wi-Fi from mobile data. Both are optional extras there, not a base to design on.

## What it cannot

- Keep saving on an iPhone once the app is in the background or the phone is locked. The process is suspended, the service worker too, and Safari has no Background Fetch or Background Sync.
- Start or finish a save on its own while the app is closed. Nothing wakes an iOS web app silently; a push must show a notification.
- Count on audio playback to keep a save alive. The WebKit source points that way, no document promises it, and it is untested here.
- Tell Wi-Fi from mobile data on an iPhone. A "save only on Wi-Fi" option cannot be enforced there; the user has to decide when saving runs.
- Know the free space on the device, or trust `estimate().quota` as a measure of it. Both engines report an artificial number.
- Trust its own local list of kept books after an eviction. The list lives in the same storage and disappears with the files, so the record of what this device should hold has to survive somewhere else, such as the server.
- Assume `persist()` stays granted, or was granted at all in a Safari tab. The answer is re-evaluated at every call.
- Assume the exemption from the seven-day cap when the app runs in a Safari tab, or from an icon the user added as a bookmark (iOS 26 and later offer that choice).
- Share saved files between Safari and the installed app. Their storage is separate, and only cookies are copied when the icon is created.
- Stop the user from clearing the data, or learn in advance that it will be cleared.
- Rule out a browser bug. Safari 17.4 fixed "cases where website data is unexpectedly evicted".
