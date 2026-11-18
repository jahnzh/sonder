import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { skipOnMobile } from "./mobile";
import { listenFace, openListen } from "./now-playing";
import { listenOnBookPage, playFromLibrary } from "./library-play";
function wave() {
  const seconds = 10,
    n = 8000 * seconds,
    b = Buffer.alloc(44 + n * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.round(Math.sin((i * 440 * Math.PI * 2) / 8000) * 1000),
      44 + i * 2,
    );
  return b;
}
// A recording of this test's own, titled uniquely per run. The seeded Alice carries listening progress, an ebook and a
// "most recent" place on the feature card from the other specs on a shared server (and from the previous repeat),
// so tests that play, resume or open the player import their own book instead of using it.
async function importOwnBook(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", {
    multipart: {
      title,
      author: "Sonder test",
      file0: { name: "Track 1.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") },
    },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  importedWorks.push(book.workId);
  return book as { id: string; title: string; workId: string; tracks: { id: string }[] };
}
// The works this file's tests imported. Playing one makes it the most recently played book, so the dock and the
// feature card of every later spec on the same shard server would open it instead of Alice (which about twenty specs
// reach through `.dock-book`). After each test its books leave the library through the route the book dialog's
// Remove uses, as if the owner had removed them: the server is left with the library it had before the test.
const importedWorks: string[] = [];
test.afterEach(async ({ page }) => {
  for (const workId of importedWorks.splice(0)) {
    const removed = await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`);
    expect(removed.ok()).toBe(true);
  }
});
const SEEDED_TITLES = [
  "Alice’s Adventures in Wonderland",
  "The Adventures of Sherlock Holmes",
  "Pride and Prejudice",
  "Frankenstein",
  "The Time Machine",
  "Meditations",
];
test("dark mobile library, browsing, filters, favorites and ebook sources", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  // The Library by work (#577): the Title, one tile per work.
  await expect(
    page.getByRole("heading", { name: "Library", exact: true, level: 1 }),
  ).toBeVisible();
  // Other specs on a shared server (a repeat run) add books, so prove the six seeded books by title, not the total.
  for (const title of SEEDED_TITLES)
    await expect(
      page.getByRole("button", { name: `About ${title}`, exact: true }),
    ).toHaveCount(1);
  // Guard 1 (spec #572): no horizontal overflow and the dark ground.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    page.viewportSize()!.width,
  );
  expect(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(16, 21, 16)");
  // Guard 2: a book made a favourite (the Book page's Favorite, by work) is under the Favorites chip, after a reload too.
  await page
    .getByRole("button", { name: "About Frankenstein", exact: true })
    .click();
  await page.getByRole("button", { name: "Favorite", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Favorite", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.goto("/#library");
  const chips = page.getByRole("group", { name: "Filter your library", exact: true });
  await chips.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator(".library-tile")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "About Frankenstein", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".library-tile")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Favorites", exact: true, level: 2 }),
  ).toBeVisible();
  // Guard 3: Finished with no finished book among the favourites says "No books" (the chips combine with Search too).
  await page.getByRole("button", { name: "Search your library", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search your library", exact: true }).fill("Frankenstein");
  await chips.getByRole("button", { name: "Finished", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No books", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(chips.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The favourite is taken back, so the next spec on a shared server starts without it.
  await page
    .getByRole("button", { name: "About Frankenstein", exact: true })
    .click();
  await page.getByRole("button", { name: "Favorite", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Favorite", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.goto("/#library");
  await page
    .getByRole("button", { name: "Discover", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Discover" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ebooks", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Search on Library Genesis" }),
  ).toBeVisible();
  await expect(page.getByText("Anna’s Archive")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("real audio playback, speed, seek, pause and recording-specific resume after reload", async ({
  page,
}) => {
  const own = await importOwnBook(page, "Playback resume");
  await page.goto(`/#book/${encodeURIComponent(own.workId)}`);
  await listenOnBookPage(page);
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const books = await (await page.request.get("/api/books")).json();
        return (
          books.find((b: { id: string }) => b.id === own.id).progress
            ?.position || 0
        );
      },
      { timeout: 12000 },
    )
    .toBeGreaterThan(1);
  await page
    .locator(".player-dock")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  const before = (await (await page.request.get("/api/books")).json()).find(
    (b: { id: string }) => b.id === own.id,
  ).progress.position;
  await page.goto("/#library");
  await page.reload();
  // Continue (#577): the book with the newest place, with Play.
  const continued = page.getByRole("region", { name: "Continue", exact: true });
  await expect(continued.getByRole("button", { name: `Continue ${own.title}`, exact: true })).toBeVisible();
  await continued.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const b = (await (await page.request.get("/api/books")).json()).find(
          (b: { id: string }) => b.id === own.id,
        );
        return b.progress?.position || 0;
      },
      { timeout: 10000 },
    )
    .toBeGreaterThanOrEqual(before);
  // Now playing's Listen face (#593): Speed is a Stepper row, the sleep timer a row with a picker.
  await openListen(page);
  const listen = listenFace(page);
  const speed = listen.getByRole("spinbutton", { name: "Playback speed", exact: true });
  const stepTo = async (text: string) => {
    for (let i = 0; i < 60 && (await speed.getAttribute("aria-valuetext")) !== text; i++)
      await listen.getByRole("button", { name: "Faster", exact: true }).click();
    await expect(speed).toHaveAttribute("aria-valuetext", text);
  };
  await stepTo("1.5×");
  await page
    .getByRole("slider", { name: "Seek in audiobook", exact: true })
    .fill("30");
  await expect
    .poll(async () => {
      const b = (await (await page.request.get("/api/books")).json()).find(
        (b: { id: string }) => b.id === own.id,
      );
      return b.progress?.position || 0;
    })
    .toBeGreaterThanOrEqual(30);
  await listen.getByRole("button", { name: "Sleep timer Off", exact: true }).click();
  await page.getByRole("dialog", { name: "Sleep timer", exact: true }).getByRole("radio", { name: "5 minutes", exact: true }).click();
  await expect(listen.getByRole("button", { name: /^Sleep timer / })).toHaveText(/5 min/);
  await stepTo("2.4×");
  await expect(page.locator(".timeline-speed-left")).toContainText(
    "left at 2.4×",
  );
  await page.getByRole("button", { name: "Close now playing", exact: true }).click();
  await page.reload();
  await openListen(page);
  await expect(listenFace(page).getByRole("spinbutton", { name: "Playback speed", exact: true })).toHaveAttribute("aria-valuetext", "2.4×");
  await page.getByRole("button", { name: "Close now playing", exact: true }).click();
});
test("import, complete device download, service-worker ranges and offline relaunch", async ({
  page,
  context,
}) => {
  // Unique per run: /api/import does not dedupe audio, so a repeat on one server would add a second row of the same title.
  const story = `A tiny offline story ${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  // The import dialog is the navigation's Add an audiobook (the Library's plus opens Discover, #577).
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Add an audiobook", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "A tiny offline story.wav",
    mimeType: "audio/wav",
    buffer: wave(),
  });
  await page
    .getByRole("textbox", { name: "Book title", exact: true })
    .fill(story);
  await page
    .getByRole("textbox", { name: "Author", exact: true })
    .fill("Sonder test");
  await page
    .getByRole("button", { name: "Add to my library", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("button", { name: `About ${story}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `About ${story}`, exact: true })
    .click();
  // The Book page's Keep on this device switch saves the book: the saver saves the chosen recording (#550).
  await page.getByRole("switch", { name: "Keep on this device", exact: true }).click();
  await expect(page.locator("#book-keep-line")).toHaveText(/^Audiobook · /, { timeout: 20000 });
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  const books = await (await page.request.get("/api/books")).json();
  const book = books.find(
    (b: { title: string }) => b.title === story,
  );
  importedWorks.push(book.workId);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText("You’re offline. Downloaded books are available."),
  ).toBeVisible();
  // On device (#577): Keep on and complete.
  await page.getByRole("group", { name: "Filter your library", exact: true }).getByRole("button", { name: "On device", exact: true }).click();
  await expect(page.locator(".library-tile")).toHaveCount(1);
  await page
    .getByRole("button", { name: `About ${story}`, exact: true })
    .click();
  await listenOnBookPage(page);
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  const range = await page.evaluate(async (id: string) => {
    const r = await fetch("/api/media/" + id, {
      headers: { Range: "bytes=0-43" },
    });
    return {
      status: r.status,
      range: r.headers.get("Content-Range"),
      body: [...new Uint8Array(await r.arrayBuffer())],
    };
  }, book.tracks[0].id);
  expect(range.status).toBe(206);
  expect(range.range).toBe(`bytes 0-43/${wave().length}`);
  expect(Buffer.from(range.body)).toEqual(wave().subarray(0, 44));
  await context.setOffline(false);
});
test("desktop layout and server/device distinction remain usable without overflow", async ({
  page,
}) => {
  skipOnMobile(true, "desktop layout (min-width: 900px) is not reachable on a phone profile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#activity");
  // Now lists the server's work and this device's saves together (#522).
  await expect(page.getByTestId("activity-now")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1440,
  );
  // This device's saves are Activity's This device (#518).
  await page.goto("/#activity/device");
  await expect(
    page.getByRole("list", { name: "Kept on this device", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1440,
  );
  // Settings shows the server's connections beside the list (spec #572, list 5).
  await page.goto("/#settings/connections");
  await expect(page.getByRole("navigation", { name: "Settings", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your home server", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Anna’s Archive", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Library Genesis", exact: true }),
  ).toBeVisible();
});
test("embedded chapter controls seek within a recording without changing the physical track ID", async ({
  page,
}) => {
  const own = await importOwnBook(page, "Chapter controls");
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const books = await response.json();
    const mine = books.find((b: { id: string }) => b.id === own.id);
    mine.tracks[0].chapters = [
      { title: "At the beginning", start: 0, end: 20 },
      { title: "A new turn", start: 20, end: 40 },
      { title: "The long way home", start: 40, end: 640 },
    ];
    await route.fulfill({ response, json: books });
  });
  await page.goto("/");
  await playFromLibrary(page, own.title);
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  // Chapters from Listen is a page of the recording's chapters (#593); a row moves the narration and returns.
  await openListen(page);
  await listenFace(page).getByRole("button", { name: /^Chapters / }).click();
  await page.getByRole("list", { name: "Chapters", exact: true }).getByRole("button", { name: /At the beginning/ }).click();
  await expect(listenFace(page).getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await listenFace(page).getByRole("button", { name: /^Chapters / }).click();
  await page.getByRole("list", { name: "Chapters", exact: true }).getByRole("button", { name: /A new turn/ }).click();
  await expect
    .poll(async () => {
      const b = (await (await page.request.get("/api/books")).json()).find(
        (b: { id: string }) => b.id === own.id,
      );
      return b.progress?.position || 0;
    })
    .toBeGreaterThanOrEqual(20);
  const saved = (await (await page.request.get("/api/books")).json()).find(
    (b: { id: string }) => b.id === own.id,
  );
  expect(saved.progress.trackId).toBe(own.tracks[0].id);
  await listenFace(page).getByRole("button", { name: /^Chapters / }).click();
  await expect(page.getByRole("list", { name: "Chapters", exact: true }).getByRole("button", { name: /A new turn/ })).toHaveAttribute("aria-current", "true");
});
