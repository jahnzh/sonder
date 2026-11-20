// @projects firefox
import { test, expect } from "@playwright/test";
import type { AudiobookRelease } from "../../src/types";
test("multiple audiobook releases are shown in English and one is explicitly chosen for an existing book", async ({
  page,
}) => {
  const release = (
    id: string,
    language: string,
    narrator: string,
    format: string,
  ): AudiobookRelease => ({
    id,
    language,
    narrator,
    format,
    title: "Alice’s Adventures in Wonderland",
    author: "Lewis Carroll",
    url: `https://audiobookbay.lu/abss/${id}/`,
    bitrate: "64 Kbps",
    size: `${id.length}00 MB`,
    posted: "20 Oct 2026",
    uploader: "reader",
    description: "A complete audiobook recording.",
  });
  const english = release("english", "English", "English Reader", "M4B"),
    french = release("french", "French", "French Reader", "MP3"),
    alternative = release(
      "english-alternative",
      "English",
      "Another Narrator",
      "MP3",
    );
  await page.route("**/api/discover/abb/releases?*", (route) =>
    route.fulfill({ json: { results: [french, english, alternative], nextPage: null } }),
  );
  const chosen: any[] = [];
  await page.route("**/api/discover/abb/add", (route) => {
    chosen.push(route.request().postDataJSON());
    return route.fulfill({
      json: { id: "chosen-release", backend: "local", status: "downloading" },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  // From the Audiobook page's Get another recording (#530): the Get audiobook sheet (#601).
  await page
    .getByRole("region", { name: "Book", exact: true })
    .getByRole("button", { name: /^Audiobook / })
    .click();
  await expect(page).toHaveURL(/#book\/work-alice\/audiobook$/);
  await page
    .getByRole("button", { name: "Get another recording", exact: true })
    .click();
  await expect(page).toHaveURL(/#book\/work-alice\/get\/audiobook$/);
  const sheet = page.getByRole("dialog", { name: "Get audiobook", exact: true });
  const rows = sheet.getByRole("radio");
  // English only, until the language picker.
  await expect(rows).toHaveCount(2);
  await expect(sheet).not.toContainText("French Reader");
  // A tap only chooses.
  await rows.filter({ hasText: "Another Narrator" }).click();
  await expect(rows.filter({ hasText: "Another Narrator" })).toHaveAttribute("aria-checked", "true");
  expect(chosen).toEqual([]);
  await sheet.getByRole("button", { name: "Get this recording", exact: true }).click();
  await expect.poll(() => chosen.length).toBe(1);
  expect(chosen[0]).toEqual({
    slug: "english-alternative",
    workId: "work-alice",
  });
  await expect(page).toHaveURL(/#book\/work-alice\/audiobook$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});
test("removing and restoring a library book sends no empty JSON body and persists across reloads", async ({
  page,
}) => {
  // The Book page removes and adds the whole work (#527, #532): DELETE and PUT /api/works/<workId>/library, no body.
  const membership = (method: "DELETE" | "PUT") =>
    page.waitForRequest(
      (request) =>
        request.method() === method &&
        new URL(request.url()).pathname === "/api/works/work-alice/library",
    );
  const expectNoBody = (request: import("@playwright/test").Request) => {
    expect(request.headers()["content-type"]).toBeUndefined();
    expect(request.postData()).toBeNull();
  };
  const book = page.getByRole("region", { name: "Book", exact: true });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  const removed = membership("DELETE");
  await book.getByRole("button", { name: "Remove from library", exact: true }).click();
  await book
    .getByRole("group", { name: "Remove from library?", exact: true })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  expectNoBody(await removed);
  await expect(page.locator(".toast")).toContainText("Removed from your library");
  await expect(page).toHaveURL(/#library$/);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    }),
  ).toHaveCount(0);
  // The book's page outside the library says so and adds it back, staying on the book.
  await page.goto("/#book/work-alice");
  await expect(book.getByTestId("book-place")).toHaveText("Not in your library");
  const added = membership("PUT");
  await book.getByRole("button", { name: "Add to library", exact: true }).click();
  expectNoBody(await added);
  await expect(book.getByRole("button", { name: "Listen", exact: true })).toBeVisible();
  await expect(book.getByRole("button", { name: "Remove from library", exact: true })).toBeVisible();
  await page.reload();
  await expect(book.getByRole("button", { name: "Listen", exact: true })).toBeVisible();
  await book.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    }),
  ).toBeVisible();
});
