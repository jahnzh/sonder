import { test } from "@playwright/test";

// Specs that need a keyboard or the min-width: 900px layout skip on the mobile-* projects (isMobile),
// with the reason in the report instead of silently not running. Call it first in the test body.
export function skipOnMobile(isMobile: boolean, reason: string) {
  test.skip(isMobile, reason);
}
