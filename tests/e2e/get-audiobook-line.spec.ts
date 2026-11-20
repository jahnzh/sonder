// @projects firefox
// The line under Get this recording (#603, spec #600 "What the line under the button says"; guards 10 and 11 of its
// list): with a download for the book on its way (a routed library answer) the line says it is replaced and the add
// is sent with `replaceActive: true`, with no dialog; "Plays from TorBox right away." on a cached row; the torrent
// client's message in the failed colour with a routed health answer; and a second recording for a book that has one
// got with no question and nothing replaced. The sources and the add are routed: nothing is downloaded.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { AudiobookRelease, WorkMediaState } from "../../src/types";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

// The seeded LibriVox books: The Art of War shown without audio, Alice with its recording.
const WAR = { workId: "work-war", title: "The Art of War" };
const ALICE = { workId: "work-alice", title: "Alice’s Adventures in Wonderland" };
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect((await page.request.delete(`/api/works/${WAR.workId}/library`)).ok()).toBe(true);
});

const PROWLARR_CACHED = `prowlarr-${"c".repeat(32)}`;
const PROWLARR_MISS = `prowlarr-${"d".repeat(32)}`;
const release = (id: string, over: Partial<AudiobookRelease> = {}): AudiobookRelease => ({
  id,
  title: "The Art of War",
  author: "Sun Tzu",
  url: `https://audiobookbay.lu/abss/${id}/`,
  language: "English",
  narrator: "Aidan Gillen",
  format: "M4B",
  bitrate: "64 Kbps",
  size: "120 MB",
  posted: null,
  uploader: null,
  description: "",
  source: "abb",
  ...over,
});
const ABB = [release("war-gillen")];
const PROWLARR = [
  release(PROWLARR_CACHED, { source: "prowlarr", narrator: "Cached Reader", size: "480 MB", infoHash: "c".repeat(40), cached: true, seeders: 24 }),
  release(PROWLARR_MISS, { source: "prowlarr", narrator: "Seeded Reader", size: "900 MB", infoHash: "d".repeat(40), cached: false, seeders: 9 }),
];

const ON_ITS_WAY: WorkMediaState = {
  state: "queued",
  holdReason: null,
  acquisition: { id: "acq-on-its-way", status: "downloading", progress: 0.43, error: null },
};
const REPLACES = "Replaces the download on its way (Downloading to server · 43%).";
const DOWN = "The local torrent client cannot be reached. On the server, run: docker restart sonder-torrents";

const sheet = (page: Page) => page.getByRole("dialog", { name: "Get audiobook", exact: true });
const rows = (page: Page) => sheet(page).getByRole("radiogroup", { name: "Recordings", exact: true }).getByRole("radio");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const line = (page: Page) => sheet(page).getByTestId("get-line");
const getButton = (page: Page) => sheet(page).getByRole("button", { name: "Get this recording", exact: true });
const bookRegion = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));

type Posts = { url: string; body: Record<string, unknown> }[];

/**
 * The sources and the add answered by the test, TorBox and Prowlarr shown as connected or not, the torrent client's
 * health routed when given; every add counted, and any dialog other than the sheet and its Picker counted too.
 */
async function sources(page: Page, options: { torbox: boolean; health?: { status: string; message: string } }) {
  const posts: Posts = [];
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route
      .fulfill({ response, json: { ...(await response.json()), prowlarrConfigured: true, torboxConfigured: options.torbox } })
      .catch(() => {});
  });
  if (options.health)
    await page.route("**/api/torrents/health*", (route) =>
      route.fulfill({ json: { session: false, network: "unknown", version: null, checkedAt: Date.now(), ...options.health } }).catch(() => {}),
    );
  await page.route("**/api/discover/abb/releases?*", (route) => route.fulfill({ json: { results: ABB, nextPage: null } }).catch(() => {}));
  await page.route("**/api/discover/prowlarr/releases?*", (route) => route.fulfill({ json: { results: PROWLARR, nextPage: null } }).catch(() => {}));
  for (const path of ["abb", "prowlarr"])
    await page.route(`**/api/discover/${path}/add`, async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posts.push({ url: route.request().url(), body });
      await route
        .fulfill({
          json: {
            id: "acq-new",
            backend: "local",
            status: "downloading",
            progress: 0.05,
            error: null,
            ...(body.replaceActive ? { replaced: "stopped_local" } : {}),
          },
        })
        .catch(() => {});
    });
  return posts;
}

/** The work as the library and the work read give it, changed by `change` (a state the suite's server cannot make). */
async function routedWork(page: Page, workId: string, change: (work: any) => any) {
  const apply = (work: any) => (work.workId === workId ? change(work) : work);
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    await route.fulfill({ status: 200, contentType: "application/json", json: (await response.json()).map(apply) }).catch(() => {});
  });
  await page.route(`**/api/works/${encodeURIComponent(workId)}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: apply(await response.json()) }).catch(() => {});
  });
}
const withoutAudioOnItsWay = (work: any) => ({
  ...work,
  recordings: [],
  chosenRecordingId: null,
  ebooks: [],
  chosenEbookId: null,
  readingSync: [],
  mediaState: ON_ITS_WAY,
});

for (const size of [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
])
  test(`a download on its way: the line says it is replaced and Get sends replaceActive, with no dialog (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    expect((await page.request.put(`/api/works/${WAR.workId}/library`)).ok()).toBe(true);
    const posts = await sources(page, { torbox: true, health: { status: "unreachable", message: DOWN } });
    await routedWork(page, WAR.workId, withoutAudioOnItsWay);
    let dialogs = 0;
    page.on("dialog", () => dialogs++);
    await page.goto(`/#book/${WAR.workId}`);
    await expect(bookRegion(page).getByRole("list", { name: "Files", exact: true })).toContainText("Downloading to server · 43%");
    await page.goto(`/#book/${WAR.workId}/get/audiobook`);
    await expect(rows(page)).toHaveCount(3);
    // Nothing chosen: no line.
    await expect(line(page)).toHaveCount(0);
    // The replace line comes first, whatever the row: cached, checked and not cached, or AudioBookBay's.
    for (const name of ["Cached Reader", "Seeded Reader", "Aidan Gillen"]) {
      await row(page, name).click();
      await expect(line(page)).toHaveText(REPLACES);
      await expect(line(page)).not.toHaveClass(/get-sheet-line-failed/);
    }
    await noOverflow(page);
    await page.screenshot({ path: `${OUT}/get-audiobook-replace-${size.name}.png` });
    await row(page, "Seeded Reader").click();
    await getButton(page).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual({
      url: expect.stringContaining("/api/discover/prowlarr/add"),
      body: { id: PROWLARR_MISS, workId: WAR.workId, replaceActive: true },
    });
    // No question asked: the sheet closes to the Book page.
    await expect(page).toHaveURL(new RegExp(`#book/${WAR.workId}$`));
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(dialogs).toBe(0);
  });

test("a cached row plays from TorBox; the others say what happens with TorBox connected", async ({ page }) => {
  // The torrent client is down: a cached row does not need it, an AudioBookBay row is checked by TorBox when got.
  await sources(page, { torbox: true, health: { status: "unreachable", message: DOWN } });
  await page.goto(`/#book/${WAR.workId}/get/audiobook`);
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, "Cached Reader")).toContainText("Plays now");
  await row(page, "Cached Reader").click();
  await expect(line(page)).toHaveText("Plays from TorBox right away.");
  await row(page, "Aidan Gillen").click();
  await expect(line(page)).toHaveText("Plays at once if TorBox has it, else downloads to your server.");
  // Checked by TorBox and not there: it needs the torrent client, whose message stands in the failed colour.
  await row(page, "Seeded Reader").click();
  await expect(line(page)).toHaveText(DOWN);
  await expect(line(page)).toHaveClass(/get-sheet-line-failed/);
  await noOverflow(page);
});

test("the torrent client's message in the failed colour with a routed health answer, the plain line when it is ok", async ({ page }) => {
  let health = { status: "auth", message: "The local torrent client rejected the username or password." };
  await sources(page, { torbox: false });
  await page.route("**/api/torrents/health*", (route) =>
    route.fulfill({ json: { session: false, network: "unknown", version: null, checkedAt: Date.now(), ...health } }).catch(() => {}),
  );
  await page.goto(`/#book/${WAR.workId}/get/audiobook`);
  await expect(rows(page)).toHaveCount(3);
  await row(page, "Aidan Gillen").click();
  await expect(line(page)).toHaveText(health.message);
  await expect(line(page)).toHaveClass(/get-sheet-line-failed/);
  const danger = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(await line(page).evaluate((element) => getComputedStyle(element).color)).toBe(danger);
  // A cached row still plays from TorBox: TorBox's own check found it.
  await row(page, "Cached Reader").click();
  await expect(line(page)).toHaveText("Plays from TorBox right away.");
  await page.screenshot({ path: `${OUT}/get-audiobook-torrent-client.png` });
  // The client answers ok again (a reload reads the health afresh): the plain line, not in the failed colour.
  health = { status: "ok", message: "Local torrents are working." };
  await page.reload();
  await expect(rows(page)).toHaveCount(3);
  await row(page, "Aidan Gillen").click();
  await expect(line(page)).toHaveText("Downloads to your server first.");
  await expect(line(page)).not.toHaveClass(/get-sheet-line-failed/);
});

test("a second recording for a book that has one is got with no question; nothing is replaced and the first stays", async ({ page }) => {
  const before = await (await page.request.get(`/api/works/${ALICE.workId}`)).json();
  const first = before.recordings.map((recording: { recordingId: string }) => recording.recordingId);
  expect(first.length).toBeGreaterThan(0);
  const posts = await sources(page, { torbox: true });
  let dialogs = 0;
  page.on("dialog", () => dialogs++);
  await page.goto(`/#book/${ALICE.workId}/audiobook`);
  await page.getByRole("button", { name: "Get another recording", exact: true }).click();
  await expect(rows(page)).not.toHaveCount(0);
  await row(page, "Aidan Gillen").click();
  await expect(line(page)).toHaveText("Plays at once if TorBox has it, else downloads to your server.");
  await getButton(page).click();
  await expect.poll(() => posts.length).toBe(1);
  // No replaceActive: the book's recording is not a download on its way.
  expect(posts[0]).toEqual({ url: expect.stringContaining("/api/discover/abb/add"), body: { slug: "war-gillen", workId: ALICE.workId } });
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(dialogs).toBe(0);
  const after = await (await page.request.get(`/api/works/${ALICE.workId}`)).json();
  expect(after.recordings.map((recording: { recordingId: string }) => recording.recordingId)).toEqual(expect.arrayContaining(first));
});
