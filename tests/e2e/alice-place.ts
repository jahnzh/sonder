import { expect, type Page } from "@playwright/test";

// A spec that plays Alice (Use Hardcover position) moves her saved place on the server, which the next spec on the
// same server (media-controls: Space toggles playback, the shortcut sheet) then finds changed (#529, #645).
// `rememberAlicesPlace` reads it before the test; the returned `restore` writes it back through the app's own route.
type Place = { recordingId: string; trackId: string; position: number; duration: number; updatedAt: number };

async function aliceOf(page: Page) {
  const books = await (await page.request.get("/api/books")).json();
  return books.find((book: { id: string }) => book.id === "alice") as
    | { recordingId: string; tracks: { id: string; duration: number }[]; progress?: Place | null }
    | undefined;
}

export async function rememberAlicesPlace(page: Page) {
  const alice = await aliceOf(page);
  const before = alice?.progress ?? null;
  return async function restore() {
    const now = await aliceOf(page);
    if (!now) return;
    const first = now.tracks[0];
    const place = before ?? { recordingId: now.recordingId, trackId: first.id, position: 0, duration: first.duration };
    const newest = now.progress?.updatedAt ?? 0;
    const response = await page.request.post("/api/progress", {
      data: {
        recordingId: place.recordingId,
        trackId: place.trackId,
        position: place.position,
        duration: place.duration,
        updatedAt: Math.max(Date.now(), newest + 1),
      },
    });
    expect(response.ok()).toBe(true);
  };
}
