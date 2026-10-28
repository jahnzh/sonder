import { test, expect } from "@playwright/test";
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
test("dark mobile library, browsing, filters, favorites and ebook sources", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your library." }),
  ).toBeVisible();
  await expect(page.locator(".book-card")).toHaveCount(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  expect(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(16, 21, 16)");
  await page
    .getByRole("button", { name: "Add Frankenstein to favorites", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: /Favorites/ }).click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Your favorites." }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Finished", exact: true }).click();
  await expect(page.getByText("No books")).toBeVisible();
  await page.getByRole("tab", { name: "All books", exact: true }).click();
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
  await page.goto("/");
  await page
    .locator(".feature")
    .getByRole("button", { name: "Start listening", exact: true })
    .click();
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
          books.find((b: { id: string }) => b.id === "alice").progress
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
    (b: { id: string }) => b.id === "alice",
  ).progress.position;
  await page.reload();
  await page
    .locator(".feature")
    .getByRole("button", { name: "Continue listening", exact: true })
    .click();
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const b = (await (await page.request.get("/api/books")).json()).find(
          (b: { id: string }) => b.id === "alice",
        );
        return b.progress?.position || 0;
      },
      { timeout: 10000 },
    )
    .toBeGreaterThanOrEqual(before);
  await page.locator(".dock-book").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: /^Playback speed/ })
    .last()
    .click();
  await page.getByRole("button", { name: "1.5×", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^Playback speed/ }).last(),
  ).toHaveText("1.5×");
  await page
    .getByRole("slider", { name: "Seek in audiobook", exact: true })
    .fill("30");
  await expect
    .poll(async () => {
      const b = (await (await page.request.get("/api/books")).json()).find(
        (b: { id: string }) => b.id === "alice",
      );
      return b.progress?.position || 0;
    })
    .toBeGreaterThanOrEqual(30);
  await page
    .getByRole("button", { name: "Sleep timer", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "5 minutes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sleep timer", exact: true }).last(),
  ).toContainText("5m");
  await page
    .getByRole("button", { name: /^Playback speed/ })
    .last()
    .click();
  await page
    .getByRole("slider", { name: "Playback speed", exact: true })
    .fill("2.35");
  await page.getByRole("button", { name: "Faster", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^Playback speed/ }).last(),
  ).toHaveText("2.4×");
  await page.getByRole("button", { name: "Close options", exact: true }).click();
  await expect(page.locator(".timeline-speed-left")).toContainText(
    "left at 2.4×",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await page.locator(".dock-book").click();
  await expect(
    page.getByRole("button", { name: /^Playback speed/ }).last(),
  ).toHaveText("2.4×");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
});
test("import, complete device download, service-worker ranges and offline relaunch", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page
    .getByRole("button", { name: "Add audiobook", exact: true })
    .click();
  await page.locator("input[type=file]").setInputFiles({
    name: "A tiny offline story.wav",
    mimeType: "audio/wav",
    buffer: wave(),
  });
  await page
    .getByRole("textbox", { name: "Book title", exact: true })
    .fill("A tiny offline story");
  await page
    .getByRole("textbox", { name: "Author", exact: true })
    .fill("Sonder test");
  await page
    .getByRole("button", { name: "Add to my library", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "A tiny offline story", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "A tiny offline story", exact: true })
    .click();
  await page.getByRole("button", { name: "Save offline", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Downloaded", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const books = await (await page.request.get("/api/books")).json();
  const book = books.find(
    (b: { title: string }) => b.title === "A tiny offline story",
  );
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText("You’re offline. Downloaded books are available."),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Downloaded", exact: true }).click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Play A tiny offline story", exact: true })
    .click();
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#downloads");
  await expect(
    page.getByRole("heading", { name: /On your home server/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "On this device", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1440,
  );
  await page.goto("/#settings");
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
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const books = await response.json();
    const alice = books.find((b: { id: string }) => b.id === "alice");
    alice.tracks[0].chapters = [
      { title: "At the beginning", start: 0, end: 20 },
      { title: "A new turn", start: 20, end: 40 },
      { title: "The long way home", start: 40, end: 640 },
    ];
    await route.fulfill({ response, json: books });
  });
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
  await page.locator(".dock-book").click();
  await page.getByRole("button", { name: /At the beginning/ }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /A new turn/ }).click();
  await expect
    .poll(async () => {
      const b = (await (await page.request.get("/api/books")).json()).find(
        (b: { id: string }) => b.id === "alice",
      );
      return b.progress?.position || 0;
    })
    .toBeGreaterThanOrEqual(20);
  const alice = (await (await page.request.get("/api/books")).json()).find(
    (b: { id: string }) => b.id === "alice",
  );
  expect(alice.progress.trackId).toBe("alice-0");
  await expect(page.getByRole("button", { name: /A new turn/ })).toHaveClass(
    /selected/,
  );
});
