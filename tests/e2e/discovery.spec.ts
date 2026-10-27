import { test, expect } from "@playwright/test";
test("free Anna account can continue browser search and persist a manually downloaded ebook", async ({
  page,
}) => {
  await page.route("**/api/discover/ebooks?*", (route) =>
    route.fulfill({
      json: {
        files: [],
        browserRequired: true,
        accountAccepted: true,
        website: "https://annas-archive.gl/search?q=carl&ext=epub",
        notice:
          "Your account key was accepted. Anna’s Archive still requires browser verification; a non-member key does not skip this check. Continue your search in the browser, then import an EPUB or PDF here.",
      },
    }),
  );
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Ebooks", exact: true }).click();
  await page
    .getByRole("button", { name: "Anna’s Archive", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search ebook title or author" })
    .fill("carl");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".ebook-browser-search")).toContainText(
    "Your account key was accepted",
  );
  await expect(
    page.getByRole("link", { name: "Continue in browser" }),
  ).toHaveAttribute("href", "https://annas-archive.gl/search?q=carl&ext=epub");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/No EPUB or PDF editions found/)).toHaveCount(0);
  await page
    .getByLabel("Import ebook", { exact: true })
    .setInputFiles({
      name: "A free browser download.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"),
    });
  await expect(page.locator(".ebook-saved-list")).toContainText(
    "A free browser download",
  );
  await page.reload();
  await page.getByRole("button", { name: "Ebooks", exact: true }).click();
  await expect(page.locator(".ebook-saved-list")).toContainText(
    "A free browser download",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: "artifacts/ebook-browser-import-mobile.png",
    fullPage: true,
  });
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
