import { test, expect } from "@playwright/test";
// Guard 17 of spec #572 in its new form (#575): a Hardcover result of Discover's search is added to the library from
// its Book page (through `work-hc-<n>`, ADR 0022), and the added book's Hardcover page opens it on hardcover.app by
// the catalogue's slug. Discover's ebook search and import went with its source buttons; a book's ebook is got or
// imported in its Get ebook sheet (#604, guarded by get-ebook.spec.ts and get-import.spec.ts).
test.use({ serviceWorkers: "block" });

test("a Hardcover result is added from its Book page, and its Hardcover page uses the catalogue's slug", async ({ page }) => {
  expect((await page.request.put("/api/hardcover/token", { data: { token: "browser-test-token" } })).ok()).toBe(true);
  await page.route("https://assets.hardcover.app/**", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/#discover");
  const discover = page.getByRole("region", { name: "Discover", exact: true });
  const field = discover.getByRole("searchbox", { name: "Search for a book", exact: true });
  await field.fill("banks");
  await field.press("Enter");
  // Consider Phlebas (Hardcover book 1004) is Hardcover's, or on the server from an earlier run of this spec.
  const result = discover.getByRole("button", { name: /^Consider Phlebas Iain M\. Banks\b/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/#book\/[^/]+$/);
  const book = page.getByRole("region", { name: "Book", exact: true });
  await expect(book.getByRole("heading", { level: 1 })).toHaveText("Consider Phlebas");
  const add = book.getByRole("button", { name: "Add to library", exact: true });
  await add.click();
  await expect(add).toHaveCount(0);
  const workId = decodeURIComponent(new URL(page.url()).hash.slice("#book/".length));
  const library = (await (await page.request.get("/api/library")).json()) as { workId: string }[];
  expect(library.some((work) => work.workId === workId)).toBe(true);
  await page.goto(`/#book/${encodeURIComponent(workId)}/hardcover`);
  await expect(page.getByRole("link", { name: "Open on Hardcover", exact: true })).toHaveAttribute(
    "href",
    "https://hardcover.app/books/consider-phlebas",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});
