// Types for verification-safety.mjs as a TypeScript spec imports it (tests/e2e/reader-check-edition.spec.ts).
import type { Browser, BrowserContext } from "@playwright/test";
export function protectBrowserMutations(context: BrowserContext, baseURL: string | undefined, report: { errors: string[]; protectedWrites: number }): Promise<void>;
export function closeProtectedBrowser(context: BrowserContext, browser: Browser, report: { errors: string[]; ok?: boolean }): Promise<void>;
