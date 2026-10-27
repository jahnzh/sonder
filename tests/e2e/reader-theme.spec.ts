import { test, expect } from "@playwright/test";
import { readerFixture } from "../reader-fixture";
import { readFileSync } from "node:fs";
import { defaultAppearance } from "../../src/appearance";
test("appearance presets and custom colors persist without interrupting audio", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Play Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(245, 244, 240)",
  );
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(245, 244, 240)",
  );
  await page.getByRole("button", { name: "AMOLED", exact: true }).click();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await page.getByRole("slider", { name: "Interface text size" }).fill("1.3");
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: "artifacts/appearance-mobile.png",
    fullPage: true,
  });
  await page.request.put("/api/appearance", { data: defaultAppearance });
});
test("EPUB reader supports safe content, persistent positions, bookmarks, local sync and offline reopening", async ({
  page,
  context,
}) => {
  const audio = await page.request.post("/api/import", {
    multipart: {
      title: "Reader companion",
      author: "Lewis Carroll",
      files: {
        name: "Down the Rabbit-Hole.mp3",
        mimeType: "audio/mpeg",
        buffer: readFileSync("server/demo/alice-01.mp3"),
      },
    },
  });
  expect(audio.ok()).toBe(true);
  const bookId = (await audio.json()).id;
  const books = await (await page.request.get("/api/books")).json();
  const audioBook = books.find((book: any) => book.id === bookId);
  const upload = await page.request.post(
    `/api/ebooks/import?workId=${audioBook.workId}`,
    {
      multipart: {
        file: {
          name: "Reader companion.epub",
          mimeType: "application/epub+zip",
          buffer: await readerFixture({ script: true }),
        },
      },
    },
  );
  expect(upload.ok()).toBe(true);
  const id = (await upload.json()).id;
  await page.goto(`/#reader/${id}`);
  await expect(
    page.getByRole("dialog", { name: "Reader" }),
  ).toBeVisible();
  const frame = page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
  await expect(
    frame.getByText("Alice was beginning to get very tired", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__epubScriptExecuted),
  ).toBeUndefined();
  await expect(page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe")).toHaveAttribute(
    "sandbox",
    "allow-same-origin",
  );
  await page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("body").click({ position: { x: 340, y: 100 } });
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).checkpoint
          ?.revision || 0,
    )
    .toBeGreaterThan(0);
  const checkpoint = (
    await (await page.request.get(`/api/reader/${id}`)).json()
  ).checkpoint;
  await page.getByRole("button", { name: "Show reader controls" }).click();
  await expect(page.getByRole("group", { name: "Sync reading and audio positions" }).getByRole("button", { name: "Read from audio" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Sync reading and audio positions" }).getByRole("button", { name: "Listen from here" })).toBeVisible();
  await page
    .getByRole("button", { name: "Bookmark this passage", exact: true })
    .click();
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(page.locator(".reader-room:not(.inline-reader) .reader-bookmark")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Close reader options", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).checkpoint
          .locator.cfi,
    )
    .toBe(checkpoint.locator.cfi);
  await page.setViewportSize({ width: 430, height: 844 });
  await expect(page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Reader appearance", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Reader page theme" })
    .selectOption("sepia");
  await page
    .getByRole("slider", { name: "Reader text size", exact: true })
    .fill("23");
  await page
    .getByRole("button", { name: "Close reader options", exact: true })
    .click();
  await page.getByRole("button", { name: "Reading sync", exact: true }).click();
  const sameRelease = page.getByRole("combobox", {
    name: "Reading sync audiobook release",
  });
  const chosenRecording = await sameRelease.inputValue();
  await sameRelease.selectOption(chosenRecording);
  await sameRelease.selectOption("");
  await sameRelease.selectOption(chosenRecording);
  await page
    .getByText("Match ebook sections to audio chapters", { exact: true })
    .click();
  await page
    .getByRole("combobox", {
      name: "Audio for Down the Rabbit-Hole",
      exact: true,
    })
    .selectOption({ index: 1 });
  await expect(
    page.getByRole("button", { name: "Prepare reading sync", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Prepare reading sync", exact: true })
    .click();
  await expect(page.locator(".reader-room:not(.inline-reader) .alignment-status")).toContainText(
    "Partial alignment",
    { timeout: 15000 },
  );
  const alignment = (
    await (await page.request.get(`/api/alignments?ebookId=${id}`)).json()
  ).jobs[0];
  await page.request.patch(`/api/alignments/${alignment.id}`, {
    data: { action: "pause" },
  });
  await expect(page.locator(".reader-room:not(.inline-reader) .alignment-status")).toContainText("Paused");
  await page
    .getByRole("button", { name: "Rebuild reading sync", exact: true })
    .click();
  await expect(page.locator(".reader-room:not(.inline-reader) .alignment-status")).toContainText(
    "Partial alignment",
  );
  await page
    .getByRole("button", {
      name: "Mark alignment reviewed",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Close reader options", exact: true })
    .click();
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page
    .getByRole("button", { name: "Down the Rabbit-Hole", exact: true })
    .click();
  const sentence = page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("p").first();
  const box = (await sentence.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 10);
  await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
  await page.getByRole("dialog", { name: "Sentence actions" }).getByRole("button", { name: "Listen from here" }).click();
  await expect(
    page.getByRole("button", { name: "Pause reader audio", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pause reader audio", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save ebook offline", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Ebook saved offline", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await page.screenshot({ path: "artifacts/reader-mobile.png" });
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("body"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show reader controls" }).click();
  await expect(
    page.getByRole("button", { name: "Ebook saved offline", exact: true }),
  ).toBeDisabled();
  await expect(
    page.locator(
      '.reader-room:not(.inline-reader) .reading-sync select[aria-label="Reading sync audiobook release"]',
    ),
  ).toHaveValue(chosenRecording);
  await page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("body").click({ position: { x: 340, y: 100 } });
  await page
    .getByRole("button", { name: "Bookmark this passage", exact: true })
    .click();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).bookmarks
          .length,
    )
    .toBe(2);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).checkpoint
          .revision,
    )
    .toBeGreaterThan(checkpoint.revision);
  expect(checkpoint.locator.paragraphId).toMatch(/^0:/);
});
test("an image-only cover opens at the first readable EPUB section on a narrow phone", async ({
  page,
}) => {
  const upload = await page.request.post("/api/ebooks/import", {
    multipart: {
      file: {
        name: "Image cover reader.epub",
        mimeType: "application/epub+zip",
        buffer: await readerFixture({ cover: true }),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const { id } = await upload.json();
  const book = await (await page.request.get(`/api/reader/${id}`)).json();
  expect(book.sections[0].index).toBe(1);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`/#reader/${id}`);
  await expect(
    page
      .frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe")
      .getByText("Alice was beginning to get very tired", { exact: false }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await page.getByRole("button", { name: "Show reader controls" }).click();
  expect(
    (await page
      .getByRole("button", { name: "Search this book", exact: true })
      .boundingBox())!.width,
  ).toBeGreaterThanOrEqual(44);
});
test("a bookmark the server rejects is dropped with a notice and later bookmarks still sync", async ({
  page,
}) => {
  const upload = await page.request.post("/api/ebooks/import", {
    multipart: {
      file: {
        name: "Rejected bookmark.epub",
        mimeType: "application/epub+zip",
        buffer: await readerFixture(),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const { id } = await upload.json();
  // The first bookmark is never accepted, like one whose quote is too long.
  let rejected = "";
  await page.route(`**/api/reader/${id}/bookmarks`, async (route) => {
    const bookmark = route.request().postDataJSON()?.id;
    rejected ||= bookmark;
    if (route.request().method() !== "POST" || bookmark !== rejected)
      return route.continue();
    await route.fulfill({
      status: 400,
      json: { error: "This bookmark does not belong to this edition." },
    });
  });
  await page.goto(`/#reader/${id}`);
  const reader = page.getByRole("dialog", { name: "Reader" });
  await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
  await reader.getByRole("button", { name: "Show reader controls" }).click();
  const add = reader.getByRole("button", {
    name: "Bookmark this passage",
    exact: true,
  });
  await add.click();
  // The reader dialog hides the rest of the page from the accessibility tree.
  await expect(page.locator(".toast.error")).toContainText(
    "A bookmark could not be saved",
  );
  await add.click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).bookmarks
          .length,
    )
    .toBe(1);
  await page.unrouteAll({ behavior: "wait" });
});
test("a reader setting does not save an appearance preview", async ({
  page,
}) => {
  await page.request.put("/api/appearance", { data: defaultAppearance });
  try {
    const upload = await page.request.post("/api/ebooks/import", {
      multipart: {
        file: {
          name: "Preview reader.epub",
          mimeType: "application/epub+zip",
          buffer: await readerFixture(),
        },
      },
    });
    const { id } = await upload.json();
    await page.goto("/");
    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    // Preview Light without saving it.
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await page.evaluate((id) => {
      window.dispatchEvent(
        new CustomEvent("sonder:open-reader", { detail: { id, fromAudio: false } }),
      );
      location.hash = `reader/${id}`;
    }, id);
    const reader = page.getByRole("dialog", { name: "Reader" });
    await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
    await reader.getByRole("button", { name: "Show reader controls" }).click();
    await reader
      .getByRole("button", { name: "Reader appearance", exact: true })
      .click();
    await reader
      .getByRole("slider", { name: "Reader text size", exact: true })
      .fill("23");
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/appearance")).json()).reader
            .size,
      )
      .toBe(23);
    expect(
      (await (await page.request.get("/api/appearance")).json()).preset,
    ).toBe(defaultAppearance.preset);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      defaultAppearance.preset,
    );
  } finally {
    await page.request.put("/api/appearance", { data: defaultAppearance });
  }
});
test("startup does not write another user's cached appearance into the admin's storage", async ({
  page,
}) => {
  const light = { ...defaultAppearance, preset: "light" };
  const amoled = { ...defaultAppearance, preset: "amoled" };
  await page.addInitScript(
    ([light, amoled]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      // The admin keeps a device-only look; user 2 was the last one in this tab.
      localStorage.setItem("sonder-appearance", JSON.stringify(light));
      localStorage.setItem("sonder-appearance-device", "true");
      localStorage.setItem("sonder-user-2:sonder-appearance", JSON.stringify(amoled));
      sessionStorage.setItem("sonder-current-user", "2");
    },
    [light, amoled],
  );
  try {
    await page.goto("/");
    // The test server signs everyone in as the admin.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("sonder-appearance") || "{}").preset,
      ),
    ).toBe("light");
  } finally {
    await page.evaluate(() => {
      localStorage.removeItem("sonder-appearance");
      localStorage.removeItem("sonder-appearance-device");
      localStorage.removeItem("sonder-user-2:sonder-appearance");
    });
  }
});
