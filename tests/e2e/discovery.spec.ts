import { test, expect } from "@playwright/test";
// A manually downloaded ebook imported in Discover is a book in the Library after a reload (#556; the work joins the
// importer's library through a placeholder, #555), and Discover has no ebook shelf any more.
test("a manually downloaded ebook can be imported and is a book in the Library after reload", async ({
  page,
}) => {
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Ebooks", exact: true }).click();
  await expect(page.getByText("Your ebook shelf")).toHaveCount(0);
  await expect(page.locator(".ebook-saved-list")).toHaveCount(0);
  await page
    .getByLabel("Import ebook", { exact: true })
    .setInputFiles({
      name: "A free browser download.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"),
    });
  await expect(page.getByText(/Your ebook is saved|This ebook is already on your server/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Ebooks", exact: true }).click();
  await expect(page.getByText("Your ebook shelf")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: "artifacts/ebook-browser-import-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByText("Your ebook shelf")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/ebook-browser-import-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#library");
  const book = page.locator(".book-card").filter({
    has: page.getByRole("button", { name: "A free browser download", exact: true }),
  });
  await expect(book).toBeVisible();
  await expect(book).toContainText("No audio yet");
  await page.reload();
  await expect(book).toBeVisible();
  const ebooks = (await (await page.request.get("/api/ebooks")).json()) as { title: string; workId: string }[];
  const workId = ebooks.find((e) => e.title === "A free browser download")!.workId;
  expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});
test("Hardcover discover uses catalog slugs for View book while retaining Add to library", async ({
  page,
}) => {
  await page.request.patch("/api/settings", {
    data: { hardcover: "browser-test-token" },
  });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Hardcover", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search Hardcover", exact: true })
    .fill("Alice");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const first = page.locator(".external-results article").first();
  await expect(first.getByRole("link", { name: "View book" })).toHaveAttribute(
    "href",
    "https://hardcover.app/books/alice%E2%80%99s-adventures-in-wonderland",
  );
  await expect(
    first.getByRole("button", { name: "Add to library" }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: "artifacts/hardcover-discover-links-mobile.png",
    fullPage: true,
  });
});
