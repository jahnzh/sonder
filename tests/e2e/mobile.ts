import { test } from "@playwright/test";

// Specs that need a keyboard or the min-width: 900px layout skip on the mobile-* projects, with the reason
// in the report instead of silently not running. Call it first in the test body. The project name is used
// rather than the isMobile fixture because Firefox does not support isMobile, so mobile-firefox leaves it false.
export function skipOnMobile(when: boolean, reason: string) {
  test.skip(when && test.info().project.name.startsWith("mobile-"), reason);
}
