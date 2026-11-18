import { test, expect } from '@playwright/test';

test('Library chips, search, book navigation and remembered choice', async ({ page }) => {
  await page.setViewportSize({width:390, height:844});
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#library');
  await expect(page.getByRole('heading', {name:'Library', exact:true})).toBeVisible();
  await expect(page.locator('.library-work').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(16, 21, 16)');
  if (test.info().project.name === 'chromium') {
    await page.screenshot({path:'OUT/library-phone.png'});
    await page.setViewportSize({width:1440, height:900});
    await page.screenshot({path:'OUT/library-desktop.png'});
    await page.setViewportSize({width:390, height:844});
  }
  await page.getByRole('button', {name:'Search library'}).click();
  await page.getByRole('textbox', {name:'Search your library'}).fill('Frankenstein');
  await expect(page.locator('.library-work')).toHaveCount(1);
  await page.getByRole('button', {name:'Search library'}).click();
  await page.getByRole('button', {name:'Finished', exact:true}).click();
  await page.reload();
  await expect(page.getByRole('button', {name:'Finished', exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button', {name:'All', exact:true}).click();
  await page.locator('.library-work-open').first().click();
  await expect(page).toHaveURL(/#book\//);
  expect(errors).toEqual([]);
});
