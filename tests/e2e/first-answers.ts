// A page opened or loaded again asks the server for the books and for the library by work, and lays itself out
// anew when each answers. A click made before that lands on a page that is still moving: the pointer is pressed on
// one thing and released on another, and nothing is chosen (#841; seen in Firefox on a fast host, where the answers
// arrive in the middle of the click). A spec whose first act after a navigation is a click waits for both here.
import type { Page } from "@playwright/test";

const FIRST_ANSWERS = ["/api/books", "/api/library"];

/** Runs `navigate` (a goto or a reload) and resolves once the page has the app's first answers and has drawn them. */
export async function withFirstAnswers(page: Page, navigate: () => Promise<unknown>) {
  // Listened for before the navigation: an answer that came first would never be seen.
  const answers = FIRST_ANSWERS.map((path) => page.waitForResponse((response) => new URL(response.url()).pathname === path));
  await navigate();
  await Promise.all(answers);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
