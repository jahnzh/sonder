import { test, expect } from "@playwright/test";
import type { AudiobookRelease } from "../../src/types";
test("multiple audiobook releases can be filtered, paged and explicitly chosen for an existing book", async ({
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
    size: "400 MB",
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
  await page.route("**/api/discover/abb/releases?*", (route) => {
    const second =
      new URL(route.request().url()).searchParams.get("page") === "2";
    return route.fulfill({
      json: {
        results: second ? [alternative] : [french, english],
        nextPage: second ? null : 2,
      },
    });
  });
  await page.route("**/api/discover/abb/releases/*", (route) => {
    const id = route.request().url().split("/").at(-1);
    return route.fulfill({
      json: [english, french, alternative].find((release) => release.id === id),
    });
  });
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
  // From the Audiobook page's Get another recording (#530), until the Get sheet replaces the picker.
  await page
    .getByRole("dialog", { name: "Book details" })
    .getByRole("button", { name: /^Audiobook / })
    .click();
  await expect(page).toHaveURL(/#book\/work-alice\/audiobook$/);
  await page
    .getByRole("button", { name: "Get another recording", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Release language", exact: true }),
  ).toHaveValue("English");
  await expect(page.locator(".release-card")).toHaveCount(1);
  await expect(page.locator(".release-card")).toContainText("M4B");
  await expect(page.locator(".release-card")).not.toContainText("French");
  await page
    .getByRole("button", { name: "Load more releases", exact: true })
    .click();
  await expect(page.locator(".release-card")).toHaveCount(2);
  await page
    .getByRole("combobox", { name: "Release language", exact: true })
    .selectOption("all");
  await expect(page.locator(".release-card")).toHaveCount(3);
  await page
    .locator(".release-card")
    .filter({ hasText: "French Reader" })
    .getByRole("button", { name: "Choose release", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("French");
  await expect(page.getByRole("dialog")).toContainText("French Reader");
  expect(chosen).toEqual([]);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .locator(".release-card")
    .filter({ hasText: "Another Narrator" })
    .getByRole("button", { name: "Choose release", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Another Narrator");
  await expect(page.getByRole("dialog")).toContainText("English");
  await page
    .getByRole("button", { name: "Use this release", exact: true })
    .click();
  await expect.poll(() => chosen.length).toBe(1);
  expect(chosen[0]).toEqual({
    slug: "english-alternative",
    workId: "work-alice",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});
test("removing and restoring a library book sends no empty JSON body and persists across reloads", async ({
  page,
}) => {
  // The book dialog removes and adds the whole work (#527): DELETE and PUT /api/works/<workId>/library, no body.
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
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  let removed = membership("DELETE");
  await page
    .getByRole("button", { name: "Remove from library", exact: true })
    .click();
  expectNoBody(await removed);
  await expect(page.locator(".toast")).toContainText(
    "Book removed from your library",
  );
  // The dialog stays open on the book, now outside the library, and adds it back.
  const added = membership("PUT");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add to library", exact: true })
    .click();
  expectNoBody(await added);
  await expect(page.locator(".toast")).toContainText("Added to library.");
  removed = membership("DELETE");
  await page
    .getByRole("button", { name: "Remove from library", exact: true })
    .click();
  expectNoBody(await removed);
  await expect(page.locator(".toast")).toContainText(
    "Book removed from your library",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    }),
  ).toHaveCount(0);
  expect((await page.request.put("/api/works/work-alice/library")).ok()).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    }),
  ).toBeVisible();
});
