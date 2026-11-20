// Types for the parts of live-check-recording.mjs a TypeScript spec imports (tests/e2e/reader-check-edition.spec.ts).
import type { BrowserContext } from "@playwright/test";
type Get = (path: string) => Promise<{ status: number; text: string }>;
type ListedWork = { workId: string; chosenEbookId?: string | null; ebooks?: { id: string; format: string; available: boolean }[] };
export function readEdition(work: ListedWork | null | undefined, deviceChoice: string | null | undefined): string | null;
export function sharedEdition(works: ListedWork[], workId: string): string | null;
export function requestFrom(context: BrowserContext): Get;
export function selectReaderRecording(
  get: Get,
  options?: { preferred?: string | null; allowRecent?: boolean; now?: number },
): Promise<{ recordingId: string; book: any; ebook: { id: string }; job: { id: string }; map: any; sequence: any; listing: { works: any[] } & Record<string, any>; preferred?: { recordingId: string; reason: string } }>;
