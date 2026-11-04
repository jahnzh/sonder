import { test, expect } from "@playwright/test";

test("series save opt-ins, ebook failure, and retry show specific progress", async ({
  page,
}) => {
  await page.request.put("/api/hardcover/token", {
    data: { token: "series-browser-token" },
  });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  await expect(
    page.getByText("Search for audiobooks (may download automatically)"),
  ).toBeVisible();
  await expect(
    page.getByText("Search for ebooks (may download automatically)"),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /Search for audiobooks/ }).check();
  await page.getByRole("checkbox", { name: /Search for ebooks/ }).check();
  await page.getByRole("checkbox", { name: /Crossing Two/ }).uncheck();
  await page.getByRole("checkbox", { name: /Crossing Companion/ }).check();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();
  await expect.poll(async () => {
    const view = await (await page.request.get("/api/series/701")).json();
    return view.works.some((work: { acquisition?: { audio?: { status?: string } | null } }) => {
      const status = work.acquisition?.audio?.status;
      return (
        status === "pending" ||
        status === "searching" ||
        status === "done" ||
        status === "skipped" ||
        status === "failed"
      );
    });
  }).toBe(true);
  await expect(page.getByRole("dialog").getByText(/^Audio: /).first()).toBeVisible();

  await page.getByRole("button", { name: "Close series" }).click();
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();

  const companion = page.getByRole("dialog").getByText("Crossing Companion", {
    exact: true,
  });
  await expect(companion).toBeVisible();
  await expect.poll(async () => {
    const view = await (
      await page.request.get("/api/series/701")
    ).json();
    const work = view.works.find((row: { title: string }) => row.title === "Crossing Companion");
    return work?.acquisition?.ebook?.status;
  }).toBe("failed");

  await page.getByRole("button", { name: "Retry ebook" }).click();
  await expect.poll(async () => {
    const view = await (
      await page.request.get("/api/series/701")
    ).json();
    const work = view.works.find((row: { title: string }) => row.title === "Crossing Companion");
    return work?.acquisition?.ebook?.status;
  }).toBe("done");
  await expect(
    page
      .getByRole("dialog")
      .locator(".series-work")
      .filter({ hasText: "Crossing Companion" })
      .getByText("Ebook: Search complete", { exact: true }),
  ).toBeVisible();
});
