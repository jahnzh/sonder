// The reader shows the server's prepared text on every device since #806: the hidden switch it replaced is gone.
import type { Page } from "@playwright/test";

/**
 * Nothing to choose any more. Kept only for the two pages-mode specs that #904 shortens (prepared-pages.spec.ts and
 * prepared-pages-walk.spec.ts), so that change and #806 do not touch the same lines; remove it with their last call.
 */
export async function choosePreparedView(_page: Page) {}
