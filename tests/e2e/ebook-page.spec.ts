// The Ebook page (#531, spec #526 "The Ebook page"; board Ebook.dc.html): `#book/<workId>/ebook`, opened from the
// book dialog's Ebook row. Editions with their checks; the administrator's choice sets the shared default and Read
// opens it, someone else's sets this device's choice; a PDF opens in a new tab; Import a file; Export the file; the
// device copy removed after one question, and the reader then reads from the server; measured against the board.
//
// The checks against the narration and the shared default need the ebook set's evaluation by a worker, which the
// suite's server does not run to an end: its answers for the work (`GET /api/library`, `GET /api/works/<id>`, the
// default's `PATCH`) are routed, everything else is the real server.
import { test, expect, request as playwrightRequest, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { readerFixture } from "../reader-fixture";

const unique = (label: string) => `${label} ${test.info().repeatEachIndex} ${randomBytes(3).toString("hex")}`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
type Check = { status: "pending" | "held" | "accepted" | "rejected"; holdReason: string | null };
type Edition = { id: string; format: string; size: number; check: Check | null };
type Work = { workId: string; chosenEbookId: string | null; ebooks: Edition[] };

async function importAudio(page: Page, title: string, base = "") {
  const response = await page.request.post(`${base}/api/import`, {
    multipart: { title, author: "Ebook QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  return (await (await page.request.get(`${base}/api/books`)).json()).find((b: { id: string }) => b.id === id) as { id: string; workId: string };
}
async function importEbook(page: Page, workId: string, name: string, buffer: Buffer, base = "") {
  const upload = await page.request.post(`${base}/api/ebooks/import?workId=${encodeURIComponent(workId)}`, {
    multipart: { file: { name, mimeType: name.endsWith(".pdf") ? "application/pdf" : "application/epub+zip", buffer } },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  return (await upload.json()).id as string;
}
const sizeOf = async (page: Page, workId: string, id: string, base = "") =>
  ((await (await page.request.get(`${base}/api/works/${encodeURIComponent(workId)}`)).json()) as Work).ebooks.find((e) => e.id === id)!.size;
const kb = (size: number) => `${Math.round(size / 1e3)} KB`;

/** Routes the work's reads so its editions carry `checks` and its shared default is `state.shared`; records PATCHes. */
async function routeWork(page: Page, workId: string, checks: Record<string, Check>, state: { shared: string | null; patches: unknown[] }) {
  const rewrite = (work: Work): Work =>
    work.workId !== workId
      ? work
      : { ...work, chosenEbookId: state.shared, ebooks: work.ebooks.map((e) => ({ ...e, check: checks[e.id] ?? e.check })) };
  const answer = async (route: Route, many: boolean) => {
    if (route.request().method() !== "GET") return route.fallback();
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    const body = await response.json();
    await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(many ? (body as Work[]).map(rewrite) : rewrite(body)) });
  };
  await page.route(/\/api\/library$/, (route) => answer(route, true));
  await page.route(new RegExp(`/api/works/${escape(encodeURIComponent(workId))}$`), (route) => answer(route, false));
  await page.route(new RegExp(`/api/works/${escape(encodeURIComponent(workId))}/ebook-set/default$`), async (route) => {
    const body = route.request().postDataJSON() as { ebookId: string };
    state.patches.push(body);
    state.shared = body.ebookId;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ defaultEbookId: body.ebookId, defaultEbookOverride: body.ebookId, members: [], consensus: null }) });
  });
}

const details = (page: Page) => page.getByRole("dialog", { name: "Book details" });
const editions = (page: Page) => page.getByRole("radiogroup", { name: "Editions" });
async function openFromLibrary(page: Page, title: string) {
  await page.goto("/#library");
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await expect(details(page)).toBeVisible();
}
async function closeReader(page: Page) {
  const room = page.locator(".reader-room:not(.inline-reader)");
  await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  if (!(await room.locator(".reader-topbar").isVisible())) {
    const box = (await room.locator(".reader-viewport").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await room.locator(".reader-topbar").getByRole("button", { name: "Close reader", exact: true }).click();
}

test("the administrator's Ebook page: editions and checks, shared default and Read, PDF, import, export, device copy", async ({ page }) => {
  mkdirSync("artifacts", { recursive: true });
  const title = unique("Ebook page");
  const book = await importAudio(page, title);
  // Added first, so it is the chosen one until a choice is made; it is still being checked.
  const first = await importEbook(page, book.workId, "First.epub", await readerFixture({ title: `${title} first` }));
  const matching = await importEbook(page, book.workId, "Matching.epub", await readerFixture({ title: `${title} matching`, cover: true }));
  const pdf = await importEbook(page, book.workId, "Scan.pdf", PDF);
  const state = { shared: null as string | null, patches: [] as unknown[] };
  await routeWork(page, book.workId, { [first]: { status: "pending", holdReason: null }, [matching]: { status: "accepted", holdReason: null } }, state);
  const firstSize = await sizeOf(page, book.workId, first);
  const matchingSize = await sizeOf(page, book.workId, matching);
  const pdfSize = await sizeOf(page, book.workId, pdf);

  // The dialog's Ebook row: the chosen edition's line, opening the page.
  await openFromLibrary(page, title);
  const row = details(page).getByRole("button", { name: `Ebook EPUB · ${kb(firstSize)} · On server`, exact: true });
  await expect(row).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Find ebook", exact: true })).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/ebook-row-dialog-390.png" });
  await row.click();
  await expect(page).toHaveURL(new RegExp(`#book/${escape(encodeURIComponent(book.workId))}/ebook$`));
  await expect(details(page)).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Ebook", exact: true })).toBeVisible();
  await expect(page.locator(".ebook-page-book")).toHaveText(title);

  // Editions with their checks; the PDF reads "Opens in another app"; the first EPUB is ticked.
  await expect(editions(page).getByRole("radio")).toHaveCount(2);
  const firstRow = editions(page).getByRole("radio", { name: `EPUB · ${kb(firstSize)} Checking against the narration`, exact: true });
  const matchingRow = editions(page).getByRole("radio", { name: `EPUB · ${kb(matchingSize)} Matches the narration`, exact: true });
  await expect(firstRow).toHaveAttribute("aria-checked", "true");
  await expect(matchingRow).toHaveAttribute("aria-checked", "false");
  const pdfRow = page.getByRole("button", { name: `PDF · ${kb(pdfSize)} Opens in another app`, exact: true });
  await expect(pdfRow).toBeVisible();
  await expect(page.getByRole("button", { name: "Get another edition", exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/ebook-page-phone.png", fullPage: true });

  // The administrator's tap sets the shared default.
  await matchingRow.click();
  await expect.poll(() => state.patches).toEqual([{ ebookId: matching }]);
  await expect(matchingRow).toHaveAttribute("aria-checked", "true");
  await expect(firstRow).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate((key) => localStorage.getItem(key), `reader-ebook:${book.workId}`)).toBeNull();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Ebook", exact: true })).toBeVisible();
  await expect(matchingRow).toHaveAttribute("aria-checked", "true");

  // A PDF opens its file in a new tab.
  const popup = page.waitForEvent("popup");
  const opened = page.context().waitForEvent("request", (request) => request.url().endsWith(`/api/ebooks/${encodeURIComponent(pdf)}/file`));
  await pdfRow.click();
  const tab = await popup;
  expect((await opened).frame().page()).toBe(tab);
  await tab.close();

  // Export the file downloads the chosen edition's file.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export the file", exact: true }).click();
  const file = await download;
  expect(file.url()).toContain(`/api/ebooks/${encodeURIComponent(matching)}/file`);
  expect(file.suggestedFilename()).toMatch(/\.epub$/);

  // Import a file: an EPUB from this device joins the work's editions.
  const imported = await readerFixture({ title: `${title} imported` });
  await page.getByLabel("Ebook file to import").setInputFiles({ name: "Imported.epub", mimeType: "application/epub+zip", buffer: imported });
  await expect(page.getByRole("status").filter({ hasText: "Saved on your server." })).toBeVisible();
  await expect(editions(page).getByRole("radio")).toHaveCount(3);
  const after = (await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json()) as Work;
  expect(after.ebooks.filter((e) => e.format === "epub")).toHaveLength(3);

  // Read with several EPUBs opens the chosen one, without a chooser.
  await openFromLibrary(page, title);
  await details(page).getByRole("button", { name: "Read ebook", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#reader/${escape(encodeURIComponent(matching))}$`));
  await expect(page.getByText("Choose a reading edition")).toHaveCount(0);
  await closeReader(page);

  // A copy of the edition on this device, as the reader's offline save writes it where there is no private file
  // system (Firefox's headless profile never finishes the reader's own save: its storage.persist() does not settle).
  const { fingerprint } = (await (await page.request.get(`/api/reader/${encodeURIComponent(matching)}`)).json()) as { fingerprint: string };
  await page.evaluate(
    async ({ id, fingerprint }) => {
      const blob = await (await fetch(`/api/ebooks/${encodeURIComponent(id)}/file`)).blob();
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("sonder");
        open.onsuccess = () => {
          const tx = open.result.transaction("preferences", "readwrite");
          tx.objectStore("preferences").put({ key: `reader-file:${id}`, value: { fingerprint, blob } });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { id: matching, fingerprint },
  );
  // Its copy is removed after one question.
  await openFromLibrary(page, title);
  await details(page).getByRole("button", { name: `Ebook EPUB · ${kb(matchingSize)} · On server · This device`, exact: true }).click();
  const deviceRow = page.getByRole("button", { name: `Device copy ${kb(matchingSize)}`, exact: true });
  await expect(deviceRow).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Server copy" })).toContainText(kb(matchingSize));
  await deviceRow.click();
  const question = page.getByRole("dialog", { name: "Remove from this device?" });
  await expect(question).toContainText("Your place and the library entry stay.");
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(question).toBeHidden();
  await expect(deviceRow).toBeVisible();
  await deviceRow.click();
  await question.getByRole("button", { name: "Remove from this device", exact: true }).click();
  await expect(deviceRow).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Removed from this device." })).toBeVisible();
  expect(await page.evaluate((id) => new Promise<boolean>((resolve) => {
    const open = indexedDB.open("sonder");
    open.onsuccess = () => {
      const get = open.result.transaction("preferences").objectStore("preferences").get(`reader-file:${id}`);
      get.onsuccess = () => resolve(!!get.result);
    };
  }), matching)).toBe(false);

  // The reader then reads the edition from the server.
  const fetched = page.waitForRequest((request) => request.url().endsWith(`/api/ebooks/${encodeURIComponent(matching)}/file`));
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await details(page).getByRole("button", { name: "Read ebook", exact: true }).click();
  await fetched;
  await expect(page).toHaveURL(new RegExp(`#reader/${escape(encodeURIComponent(matching))}$`));
});

test("the Ebook page measured against the board at 390 by 844 and at desktop width, and on a reload", async ({ page }) => {
  const title = unique("Ebook layout");
  const book = await importAudio(page, title);
  const first = await importEbook(page, book.workId, "One.epub", await readerFixture({ title: `${title} one` }));
  await importEbook(page, book.workId, "Two.epub", await readerFixture({ title: `${title} two` }));
  await importEbook(page, book.workId, "Scan.pdf", Buffer.concat([PDF, Buffer.from(randomBytes(8).toString("hex"))]));
  const state = { shared: null as string | null, patches: [] as unknown[] };
  await routeWork(page, book.workId, { [first]: { status: "accepted", holdReason: null } }, state);
  const address = `/#book/${encodeURIComponent(book.workId)}/ebook`;
  // A link straight to the page: nothing of the app lies behind, so its back button goes to the book.
  await page.goto("/api/health");
  await page.goto(address);
  await expect(page.getByRole("heading", { level: 1, name: "Ebook", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to the book", exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#book/${escape(encodeURIComponent(book.workId))}/ebook$`));
  await expect(page.getByRole("heading", { level: 1, name: "Ebook", exact: true })).toBeVisible();
  await expect(editions(page).getByRole("radio")).toHaveCount(2);

  const measure = () =>
    page.evaluate(() => {
      const root = document.querySelector(".ebook-page")!;
      const box = (el: Element) => el.getBoundingClientRect();
      const main = document.querySelector("main")!;
      return {
        titles: document.querySelectorAll("h1").length,
        captions: [...root.querySelectorAll("h2")].map((h) => h.textContent),
        groups: [...root.querySelectorAll(".part-group")].map((g) => g.getAttribute("aria-label") ?? document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent ?? null),
        // The line between choice rows is drawn outside each row's 64.
        choiceRows: [...root.querySelectorAll(".part-choice-row")].map((r) => r.clientHeight),
        rows: [...root.querySelectorAll(".part-row")].map((r) => [r.textContent, Math.round(box(r).height)]),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        width: Math.round(box(root).width),
        left: Math.round(box(root).left - box(main).left),
        right: Math.round(box(main).right - box(root).right),
        mainPadding: [parseFloat(getComputedStyle(main).paddingLeft), parseFloat(getComputedStyle(main).paddingRight)],
      };
    });
  const phone = await measure();
  expect(phone.titles).toBe(1);
  expect(phone.captions).toEqual(["Editions", "Available from"]);
  expect(phone.groups).toEqual(["Editions", "Available from", "Export"]);
  expect(phone.choiceRows).toEqual([64, 64]);
  expect(phone.rows.map(([label]) => String(label).replace(/\d+ KB/, "N KB"))).toEqual([
    "PDF · N KBOpens in another app",
    "Get another edition",
    "Import a file",
    "Server copyN KB",
    "Export the file",
  ]);
  for (const [, height] of phone.rows) expect(height).toBe(52);
  expect(phone.overflow).toBe(0);
  await page.screenshot({ path: "artifacts/ebook-page-390.png", fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("heading", { level: 1, name: "Ebook", exact: true })).toBeVisible();
  const desktop = await measure();
  expect(desktop.titles).toBe(1);
  expect(desktop.overflow).toBe(0);
  // One centred column.
  expect(desktop.width).toBeLessThanOrEqual(560);
  expect(Math.abs(desktop.left - desktop.right)).toBeLessThanOrEqual(2);
  expect(desktop.choiceRows).toEqual([64, 64]);
  for (const [, height] of desktop.rows) expect(height).toBe(52);
  await page.screenshot({ path: "artifacts/ebook-page-desktop.png", fullPage: true });
  // The book dialog's Ebook row at desktop width.
  await page.getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await expect(details(page).getByRole("list", { name: "Ebook", exact: true })).toBeVisible();
  await details(page).getByRole("list", { name: "Ebook", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/ebook-row-dialog-desktop.png" });
});

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
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      server.kill();
    }
    throw new Error("Authenticated browser server did not start");
  });
  test.afterAll(() => {
    server?.kill();
  });

  test("their tap sets this device's choice, and there is no Get another edition", async ({ page }) => {
    const admin = await playwrightRequest.newContext({ baseURL: base });
    expect((await admin.post("/api/auth/login", { data: { password: "admin-password" } })).ok()).toBe(true);
    const username = `reader${randomBytes(3).toString("hex")}`;
    expect((await admin.post("/api/users", { data: { username, password: "reader-password" } })).ok()).toBe(true);
    const title = unique("Reader's ebook");
    const adminPage = { request: admin } as unknown as Page;
    const book = await importAudio(adminPage, title, base);
    const first = await importEbook(adminPage, book.workId, "First.epub", await readerFixture({ title: `${title} first` }), base);
    const second = await importEbook(adminPage, book.workId, "Second.epub", await readerFixture({ title: `${title} second` }), base);
    // The second is the one that matches: an administrator's tap on it would set the shared default.
    const state = { shared: null as string | null, patches: [] as unknown[] };
    await routeWork(page, book.workId, { [second]: { status: "accepted", holdReason: null } }, state);
    expect((await page.request.post(`${base}/api/auth/login`, { data: { username, password: "reader-password" } })).ok()).toBe(true);
    const defaults: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/ebook-set/default")) defaults.push(request.method());
    });
    await page.goto(`${base}/#book/${encodeURIComponent(book.workId)}/ebook`);
    await expect(page.getByRole("heading", { level: 1, name: "Ebook", exact: true })).toBeVisible();
    await expect(editions(page).getByRole("radio")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Get another edition", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Import a file", exact: true })).toBeVisible();
    const radios = editions(page).getByRole("radio");
    await expect(radios.nth(0)).toHaveAttribute("aria-checked", "true");
    await radios.nth(1).click();
    await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
    expect(defaults).toEqual([]);
    expect(state.patches).toEqual([]);
    const user = (await (await page.request.get(`${base}/api/auth/status`)).json()).user as { id: number };
    expect(await page.evaluate((key) => localStorage.getItem(key), `sonder-user-${user.id}:reader-ebook:${book.workId}`)).toBe(second);
    // The administrator's own choice on their devices is untouched.
    expect(await page.evaluate((key) => localStorage.getItem(key), `reader-ebook:${book.workId}`)).toBeNull();
    await page.reload();
    await expect(editions(page).getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
    void first;
    await admin.dispose();
  });
});
