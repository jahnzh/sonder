import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";

// The book's Edit page (#719 part a): from the Book page's Edit row, fields edited and saved (shown as Edited, with the
// source's value and Revert), a series of the administrator's own by name with its position, a recording's narrators,
// the cover by address; the Book page and the series page show the edits. At 390 by 844 and at a desktop width. Then,
// on a server with sign-in, someone who is not the administrator: no Edit row, the page says who edits, the routes
// answer 403, and the edited values are what they see.

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });
// A 2x3 PNG for the cover address (#763).
const COVER_PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030802000000368849d60000001049444154789c6338606000440c2814004a5506c1a837df340000000049454e44ae426082", "hex");
const unique = (label: string) => `${label} ${randomBytes(3).toString("hex")}`;

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

async function importBook(page: Page, title: string, author: string, base = "") {
  const response = await page.request.post(`${base}/api/import`, {
    multipart: { title, author, file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get(`${base}/api/books`)).json()).find((entry: { id: string }) => entry.id === id);
  return book.workId as string;
}

const field = (page: Page, name: string) => page.getByTestId(`edit-${name}`);

for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]] as const) {
  test.describe(`at ${viewport.width} by ${viewport.height}`, () => {
    test.use({ viewport });

    test("edit a book's details, its series by name, the narrators and the cover; Revert gives the source's value back", async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const title = unique("Quiet Harbour");
      // A series name of this test's own: one local series per name, and a series shows one book per number.
      const seriesName = unique("Harbour Tales");
      const workId = await importBook(page, title, "Mira Sand");
      // The cover address answers with an image (#763: a cover that fails to load is drawn as the generated cover).
      await page.route("https://covers.example/**", (route) => route.fulfill({ contentType: "image/png", body: COVER_PNG }));
      await page.goto(`/#book/${encodeURIComponent(workId)}`);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(workId)}/edit$`));
      await expect(page.getByTestId("edit-page")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: "Edit", exact: true })).toBeVisible();

      const newTitle = `${title} (Edited)`;
      await field(page, "title").getByRole("textbox").fill(newTitle);
      await field(page, "subtitle").getByRole("textbox").fill("A novel");
      await field(page, "authors").getByRole("textbox").fill("Mira Sand, Ola Tide");
      await field(page, "publisher").getByRole("textbox").fill("Harbour Press");
      await field(page, "year").getByRole("textbox").fill("2019");
      await field(page, "asin").getByRole("textbox").fill("b0000harb1");
      await field(page, "abridged").getByRole("switch", { name: "Abridged" }).click();
      // A series of the administrator's own, by its name, at 2.
      const series = page.getByTestId("edit-series");
      await series.getByRole("button", { name: "Add a series", exact: true }).click();
      const adding = page.getByTestId("edit-series-add");
      await adding.getByRole("textbox", { name: "Or a series of your own" }).fill(seriesName);
      await adding.getByRole("textbox", { name: "Position" }).fill("2");
      await adding.getByRole("button", { name: "Add", exact: true }).click();
      await expect(series.getByText(`${seriesName} · Book 2`)).toBeVisible();
      // The recording's narrators.
      const narrators = page.locator('[data-testid^="edit-narrators-"]');
      await narrators.getByRole("textbox").fill("Ana Reed, Bo Lund");
      await field(page, "cover").getByRole("textbox", { name: "Cover address" }).fill("https://covers.example/harbour.jpg");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();

      // Each edited field says so, with the source's value under it.
      await expect(field(page, "title")).toHaveAttribute("data-edited", "");
      await expect(field(page, "title").getByText("Edited", { exact: true })).toBeVisible();
      await expect(field(page, "title").getByText(title, { exact: true })).toBeVisible();
      await expect(field(page, "language")).not.toHaveAttribute("data-edited", "");
      await expect(page.getByTestId("edit-series")).toHaveAttribute("data-edited", "");
      await expect(narrators.getByText("Edited", { exact: true })).toBeVisible();
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/edit-page-${size}.png`, fullPage: true });

      // Revert the subtitle: the source's (none) comes back and the field is not edited.
      await field(page, "subtitle").getByRole("button", { name: "Revert Subtitle" }).click();
      await expect(field(page, "subtitle")).not.toHaveAttribute("data-edited", "");
      await expect(field(page, "subtitle").getByRole("textbox")).toHaveValue("");

      // The Book page shows the edits: title, authors, the series line.
      await page.getByRole("button", { name: "Back to the book", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: newTitle })).toBeVisible();
      await expect(page.getByText("Mira Sand, Ola Tide", { exact: true })).toBeVisible();
      const seriesLine = page.getByRole("button", { name: `${seriesName} · Book 2` });
      await expect(seriesLine).toBeVisible();
      await expect(page.locator(".book-page-cover")).toHaveAttribute("src", "https://covers.example/harbour.jpg");
      // The local series' page lists the book; the Library's Series chip lists the series.
      await seriesLine.click();
      // On a phone the series' own page; on a desktop it stands beside the Library's Series chip, which lists it.
      await expect(page.getByRole("heading", { name: seriesName, exact: true })).toBeVisible();
      if (size === "desktop") await expect(page.getByRole("button", { name: `${seriesName} Mira Sand, Ola Tide · 0 of 1 finished`, exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Series", exact: true }).getByText(newTitle, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove series" })).toHaveCount(0);
      const listed = (await (await page.request.get("/api/series")).json()) as { name: string }[];
      expect(listed.some((item) => item.name === seriesName)).toBe(true);
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/edit-local-series-${size}.png`, fullPage: true });

      // Revert the title: the import's title is back.
      await page.goto(`/#book/${encodeURIComponent(workId)}/edit`);
      await field(page, "title").getByRole("button", { name: "Revert Title" }).click();
      await expect(field(page, "title").getByRole("textbox")).toHaveValue(title);
      expect(errors).toEqual([]);
    });
  });
}

test.describe("someone who is not the administrator", () => {
  let server: ChildProcess;
  let base = "";
  test.beforeAll(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await new Promise<number>((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const { port } = probe.address() as AddressInfo;
          probe.close(() => resolve(port));
        });
      });
      base = `http://127.0.0.1:${port}`;
      server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
        env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: String(port) },
        stdio: "ignore",
      });
      for (let i = 0; i < 100 && server.exitCode === null; i++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) return;
        } catch {
          // Not up yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      server.kill();
    }
    throw new Error("Authenticated browser server did not start");
  });
  test.afterAll(() => {
    server?.kill();
  });

  test("cannot edit (no Edit row, the page says who edits, 403) and sees the edited values", async ({ page }) => {
    const admin = await playwrightRequest.newContext({ baseURL: base });
    expect((await admin.post("/api/auth/login", { data: { password: "admin-password" } })).ok()).toBe(true);
    const username = `reader${randomBytes(3).toString("hex")}`;
    expect((await admin.post("/api/users", { data: { username, password: "reader-password" } })).ok()).toBe(true);
    const title = unique("Shared Shore");
    const workId = await importBook({ request: admin } as unknown as Page, title, "Mira Sand", base);
    const edited = await admin.patch(`/api/works/${encodeURIComponent(workId)}/metadata`, { data: { values: { title: `${title} by hand`, series: [{ id: null, name: "Shore Books", position: 1 }] } } });
    expect(edited.ok(), await edited.text()).toBe(true);

    expect((await page.request.post(`${base}/api/auth/login`, { data: { username, password: "reader-password" } })).ok()).toBe(true);
    // They add the book to their library, and see it as the administrator left it.
    expect((await page.request.put(`${base}/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
    const seen = (await (await page.request.get(`${base}/api/works/${encodeURIComponent(workId)}`)).json()) as { title: string; series: { name: string }[] };
    expect(seen.title).toBe(`${title} by hand`);
    expect(seen.series.map((entry) => entry.name)).toEqual(["Shore Books"]);
    for (const [method, url, data] of [
      ["get", `/api/works/${encodeURIComponent(workId)}/metadata`, undefined],
      ["patch", `/api/works/${encodeURIComponent(workId)}/metadata`, { values: { title: "Theirs" } }],
    ] as const) {
      const response = method === "get" ? await page.request.get(`${base}${url}`) : await page.request.patch(`${base}${url}`, { data });
      expect(response.status(), `${method} ${url}`).toBe(403);
    }
    await page.goto(`${base}/#book/${encodeURIComponent(workId)}`);
    await expect(page.getByRole("heading", { level: 1, name: `${title} by hand` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await page.goto(`${base}/#book/${encodeURIComponent(workId)}/edit`);
    await expect(page.getByText("Only the administrator edits a book's details.")).toBeVisible();
    await admin.dispose();
  });
});
