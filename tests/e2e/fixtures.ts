// Specs that also run on the Android emulator (issue #66) import `test` from here. Without
// SONDER_ANDROID_BROWSER this is Playwright's own `test`.
import { test as desktop, expect } from "@playwright/test";
import { test as android } from "../android/fixtures";

export const test = process.env.SONDER_ANDROID_BROWSER ? android : desktop;
export { expect };
