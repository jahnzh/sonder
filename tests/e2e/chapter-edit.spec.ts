// @projects firefox
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { listenFace, openListen } from "./now-playing";
import { withFirstAnswers } from "./first-answers";

// A recording's chapters on the book's Edit page (#719 part c): the Chapters row of the recording opens its editor;
// chapter titles and starts are typed, one is added and one removed, all are shifted by 2 s, and Save chapters keeps
// them. The player's chapter list and Media Session read them, the saved place stays where it was, Look up chapters by
// an ASIN whose release is 10 h long shows AudiobookDB's chapters with the reason and takes none, and Revert gives the
// file's chapters back. At 390 by 844 and at a desktop width; the files are never written (the server's tests).

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });
const unique = (label: string) => `${label} ${randomBytes(3).toString("hex")}`;
type ApiBook = { id: string; workId: string; recordingId: string; tracks: { id: string; duration: number; chapters?: { title: string; start: number; end?: number }[] }[]; progress?: { trackId: string; position: number } };

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

async function importBook(page: Page, title: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Ida Vale", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id as string;
  return bookOf(page, id);
}
const bookOf = async (page: Page, id: string) => ((await (await page.request.get("/api/books")).json()) as ApiBook[]).find((entry) => entry.id === id)!;

for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]] as const) {
  test.describe(`at ${viewport.width} by ${viewport.height}`, () => {
    test.use({ viewport });

    test("edit a recording's chapters, shift them, look them up by ASIN, play them, revert; the place never moves", async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      // The recorded AudiobookDB answers (tests/audiobookdb-fixture.ts) want a key, as the match specs set it.
      expect((await page.request.patch("/api/settings", { data: { audiobookdb: "browser-key" } })).ok()).toBe(true);
      const title = unique("Long Way Home");
      const book = await importBook(page, title);
      const file = book.tracks[0];
      expect(file.chapters ?? []).toEqual([]);
      // A saved place 30 s in: it stays where it is through every edit.
      expect((await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: file.id, position: 30, duration: file.duration, updatedAt: Date.now() } })).ok()).toBe(true);

      // The page has its first answers before the first click: a click made while they arrive can be lost (#841).
      await withFirstAnswers(page, () => page.goto(`/#book/${encodeURIComponent(book.workId)}/edit`));
      const group = page.getByTestId("edit-chapters");
      await expect(group).toBeVisible();
      const row = group.getByRole("button", { name: /1 chapter · From the files/ });
      await expect(row).toBeEnabled();
      await row.click();
      const editor = page.getByTestId("chapter-editor");
      await expect(editor).toBeVisible();
      const rows = editor.getByTestId("chapter-row");
      await expect(rows).toHaveCount(1);

      await editor.getByRole("textbox", { name: "Title of chapter 1" }).fill("Opening");
      for (const [index, name, start] of [[2, "The Turn", "0:00:20"], [3, "Long Way Home", "0:00:40"], [4, "Not wanted", "0:05:00"]] as const) {
        await editor.getByRole("button", { name: "Add a chapter", exact: true }).click();
        await expect(rows).toHaveCount(index);
        await editor.getByRole("textbox", { name: `Title of chapter ${index}` }).fill(name);
        await editor.getByRole("textbox", { name: `Start of chapter ${index}` }).fill(start);
      }
      await editor.getByRole("button", { name: "Remove chapter 4", exact: true }).click();
      await expect(rows).toHaveCount(3);
      // Two chapters at one time are refused before anything is sent.
      await editor.getByRole("textbox", { name: "Start of chapter 3" }).fill("0:00:20");
      await expect(editor.getByRole("alert")).toHaveText('"The Turn" and "Long Way Home" start at the same time.');
      await expect(editor.getByRole("button", { name: "Save chapters", exact: true })).toBeDisabled();
      await editor.getByRole("textbox", { name: "Start of chapter 3" }).fill("0:00:40");
      // Shift all by 2 s: the first stays at the start.
      await editor.getByRole("textbox", { name: "Shift all by seconds" }).fill("2");
      await editor.getByRole("button", { name: "Shift", exact: true }).click();
      await expect(editor.getByRole("textbox", { name: "Start of chapter 1" })).toHaveValue("0:00:00");
      await expect(editor.getByRole("textbox", { name: "Start of chapter 2" })).toHaveValue("0:00:22");
      await expect(editor.getByRole("textbox", { name: "Start of chapter 3" })).toHaveValue("0:00:42");
      await editor.getByRole("button", { name: "Save chapters", exact: true }).click();
      await expect(editor.getByRole("status")).toHaveText("Chapters saved");
      await expect(group.getByRole("button", { name: /3 chapters · Edited/ })).toBeVisible();
      await expectLaidOut(page);
      await page.screenshot({ path: `${OUT}/chapter-edit-${size}-${info.project.name}.png`, fullPage: true });

      const saved = await bookOf(page, book.id);
      expect(saved.tracks[0].chapters).toEqual([
        { title: "Opening", start: 0, end: 22 },
        { title: "The Turn", start: 22, end: 42 },
        { title: "Long Way Home", start: 42, end: file.duration },
      ]);
      expect([saved.progress?.trackId, saved.progress?.position]).toEqual([file.id, 30]);

      // Look up chapters by an ASIN whose release is 10 h long: shown with the reason, none taken.
      await editor.getByRole("textbox", { name: "ASIN", exact: true }).fill("B0ASINFIX1");
      await editor.getByRole("button", { name: "Look up chapters", exact: true }).click();
      await expect(editor.getByRole("alert")).toHaveText(/^The release is 10:00:00 long and this recording 0:10:41; chapters are taken only when they agree within 5 seconds\.$/);
      await expect(editor.getByText("Found on AudiobookDB · 10:00:00")).toBeVisible();
      await expect(rows).toHaveCount(3);
      await expect(editor.getByRole("textbox", { name: "Title of chapter 2" })).toHaveValue("The Turn");
      await expectLaidOut(page);
      await page.screenshot({ path: `${OUT}/chapter-lookup-${size}-${info.project.name}.png`, fullPage: true });

      // The player reads the edited chapters: its chapter list and Media Session's chapter title at the saved place.
      await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
      const listen = page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: "Listen", exact: true });
      await expect(listen).toBeEnabled();
      await listen.click();
      await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeVisible();
      await page.goBack();
      await openListen(page);
      // A phone opens the Chapters page from Listen; a desktop shows the chapters beside (#595).
      const list =
        size === "phone"
          ? page.getByRole("list", { name: "Chapters", exact: true })
          : listenFace(page).getByRole("navigation", { name: "Chapters", exact: true });
      if (size === "phone") await listenFace(page).getByRole("button", { name: /^Chapters / }).click();
      for (const name of ["Opening", "The Turn", "Long Way Home"]) await expect(list.getByRole("button", { name: new RegExp(name) })).toBeVisible();
      await expect(list.getByRole("button", { name: /The Turn/ })).toHaveAttribute("aria-current", "true");
      await expect.poll(() => page.evaluate(() => navigator.mediaSession?.metadata?.album ?? null)).toBe("The Turn");
      await page.screenshot({ path: `${OUT}/chapter-list-${size}-${info.project.name}.png`, fullPage: true });

      // Revert: the file's chapters again; the place is still where it was saved (or later, as the book played on).
      await page.goto(`/#book/${encodeURIComponent(book.workId)}/edit`);
      await page.getByTestId("edit-chapters").getByRole("button", { name: /3 chapters · Edited/ }).click();
      await page.getByTestId("chapter-editor").getByRole("button", { name: /^Revert chapters of / }).click();
      await expect(page.getByTestId("chapter-editor").getByRole("status")).toHaveText("The files' chapters are back");
      await expect(page.getByTestId("edit-chapters").getByRole("button", { name: /1 chapter · From the files/ })).toBeVisible();
      const reverted = await bookOf(page, book.id);
      expect(reverted.tracks[0].chapters).toEqual([]);
      expect(reverted.progress?.trackId).toBe(file.id);
      expect(reverted.progress!.position).toBeGreaterThanOrEqual(30);
      expect(errors).toEqual([]);
    });
  });
}
