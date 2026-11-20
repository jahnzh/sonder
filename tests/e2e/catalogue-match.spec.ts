// @projects firefox
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";

// The catalogue (#721), against recorded AudiobookDB and Open Library answers (tests/audiobookdb-fixture.ts):
// Settings › Connections with AudiobookDB (a key saved here, Test, Match library) and Open Library (no key), the
// same with the key in the server's file (a server of its own with AUDIOBOOKDB_API_KEY), and a book's match page:
// search both providers, pick, a release for the recording, Unlink. At 390 by 844 and at a desktop width.

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

async function expectLaidOut(page: Page) {
  const shown = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const width = document.documentElement.clientWidth;
    const wide = [...main.querySelectorAll("*")]
      .filter((element) => element.getBoundingClientRect().right > width + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
    return { wide, scrolls: document.documentElement.scrollWidth > width };
  });
  expect(shown.wide, "elements wider than the window").toEqual([]);
  expect(shown.scrolls).toBe(false);
}

/** A book of this run: an imported recording, titled as the fixture's AudiobookDB book. */
async function importBook(page: Page, title: string, author: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author, file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((entry: { id: string }) => entry.id === id);
  return book.workId as string;
}

for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]] as const) {
  test.describe(`at ${viewport.width} by ${viewport.height}`, () => {
    test.use({ viewport });

    test("Connections: AudiobookDB with a key saved here, Test and Match library; Open Library needs nothing", async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto("/#settings/connections");
      const main = page.locator("main");
      const group = main.getByRole("list", { name: "AudiobookDB" });
      await expect(main.getByRole("heading", { name: "AudiobookDB", exact: true })).toBeVisible();
      await expect(main.getByRole("list", { name: "Open Library" }).getByText("Not needed")).toBeVisible();
      await expect(main.getByRole("link", { name: "Data from AudiobookDB" })).toHaveAttribute("href", "https://audiobookdb.org");
      // No key in the server's file: a key saved here is used.
      await expect(group.getByText("Set in the server's file")).toHaveCount(0);
      await group.getByRole("textbox", { name: "AudiobookDB API key" }).fill("browser-key");
      await group.getByRole("button", { name: "Save AudiobookDB API key" }).click();
      await expect(page.getByText("AudiobookDB key saved.")).toBeVisible();
      await expect(group.getByText("Connected", { exact: true })).toBeVisible();
      await group.getByRole("button", { name: "Test AudiobookDB" }).click();
      await expect(page.getByText(/^AudiobookDB is connected · [\d,]+ of 10,000 units used today\.$/)).toBeVisible();
      await expect(group.getByRole("button", { name: "Disconnect AudiobookDB" })).toBeVisible();
      // Match library: the batch runs and its line says how it went.
      await group.getByRole("button", { name: "Match library" }).click();
      await expect(main.getByText(/^Matched \d+ of \d+$/)).toBeVisible({ timeout: 20_000 });
      // The books it could not match surely are listed; each opens its match page.
      const unmatched = main.getByRole("list", { name: "Not matched" });
      await expect(unmatched.getByRole("button").first()).toBeVisible();
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/catalogue-connections-${size}.png`, fullPage: true });
      await unmatched.getByRole("button").first().click();
      await expect(page.getByTestId("match-page")).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("the match page: search both providers, match, pick the recording's release, unlink", async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      // The key the previous test saved, saved again so this test runs alone too.
      expect((await page.request.patch("/api/settings", { data: { audiobookdb: "browser-key" } })).ok()).toBe(true);
      const workId = await importBook(page, "Quiet Harbour", "Mira Sand");
      const narratorBefore = (await (await page.request.get("/api/books")).json()).find((entry: { workId: string }) => entry.workId === workId).narrator;
      await page.goto(`/#book/${encodeURIComponent(workId)}`);
      await page.getByRole("button", { name: "Match", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(workId)}/match$`));
      const pageEl = page.getByTestId("match-page");
      await expect(pageEl.getByText("Not matched")).toBeVisible();
      // Filled with the title and author and searched at once: both providers answer.
      await expect(pageEl.getByRole("searchbox", { name: "Search AudiobookDB, Open Library, Google Books and iTunes" })).toHaveValue("Quiet Harbour Mira Sand");
      const abdb = pageEl.getByRole("radiogroup", { name: "AudiobookDB" });
      const open = pageEl.getByRole("radiogroup", { name: "Open Library" });
      await expect(abdb.getByRole("radio", { name: /Quiet Harbour/ })).toBeVisible();
      await expect(open.getByRole("radio", { name: /Quiet Harbour/ })).toBeVisible();
      await expect(open.getByRole("radio", { name: /Wilde Götter/ })).toHaveCount(0);
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/catalogue-match-search-${size}.png`, fullPage: true });
      const matchButton = pageEl.getByRole("button", { name: "Match", exact: true });
      await expect(matchButton).toBeDisabled();
      await abdb.getByRole("radio", { name: /Quiet Harbour/ }).click();
      await matchButton.click();
      const matched = pageEl.getByRole("list", { name: "Match" });
      await expect(matched.getByText("Quiet Harbour · Mira Sand")).toBeVisible();
      await expect(pageEl.getByText("Matched by hand")).toBeVisible();
      // The imported chapter is minutes long, the release 11 h: not linked by itself. Picked by hand.
      const releases = pageEl.getByRole("list", { name: "Releases" });
      const recordingRow = releases.getByRole("button");
      await expect(recordingRow).toContainText("None");
      await recordingRow.click();
      await page.getByRole("dialog", { name: "Release" }).getByText("Rowan Hale · 11 h 7 min · B0FERAL001").click();
      await expect(recordingRow).toContainText("Rowan Hale · 11 h 7 min · B0FERAL001");
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/catalogue-match-linked-${size}.png`, fullPage: true });
      // Only what is missing is filled: the import named a narrator, so it stays, and so does the title.
      const book = (await (await page.request.get("/api/books")).json()).find((entry: { workId: string }) => entry.workId === workId);
      expect(book.narrator).toBe(narratorBefore);
      expect(book.title).toBe("Quiet Harbour");
      await matched.getByRole("button", { name: "Unlink", exact: true }).click();
      await expect(matched.getByText("Not matched")).toBeVisible();
      await expect(releases).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test.describe("with the key in the server's file", () => {
  let server: ChildProcess;
  let base = "";
  test.beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
      env: { ...process.env, AUDIOBOOKDB_API_KEY: "file-key", PLAYWRIGHT_PORT: String(port), PLAYWRIGHT_DATA_DIR: "" },
      stdio: "ignore",
    });
    for (let i = 0; i < 150 && server.exitCode === null; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return;
      } catch (error) {
        void error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The server with AUDIOBOOKDB_API_KEY did not start");
  });
  test.afterAll(() => {
    server?.kill();
  });

  test("Connections says the key is set in the server's file and offers Test, no field and no Disconnect", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/#settings/connections`);
    const group = page.locator("main").getByRole("list", { name: "AudiobookDB" });
    await expect(group.getByText("Set in the server's file")).toBeVisible();
    await expect(group.getByRole("textbox", { name: "AudiobookDB API key" })).toHaveCount(0);
    await expect(group.getByRole("button", { name: "Disconnect AudiobookDB" })).toHaveCount(0);
    await group.getByRole("button", { name: "Test AudiobookDB" }).click();
    await expect(page.getByText(/^AudiobookDB is connected · /)).toBeVisible();
    await expectLaidOut(page);
    if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/catalogue-connections-file-key-phone.png`, fullPage: true });
  });
});
