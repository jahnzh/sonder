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


test('favorite persists by work and list view shows the place', async ({ page }) => {
  await page.goto('/#library');
  await expect(page.locator('.library-work-open').first()).toBeVisible();
  const title = await page.locator('.library-work-open strong').first().textContent();
  await page.locator('.library-work-open').first().click();
  const favorite = page.getByRole('button', {name:'Favorite', exact:true});
  await expect(favorite).toBeVisible();
  if (await favorite.getAttribute('aria-pressed') !== 'true') await favorite.click();
  await page.goto('/#library');
  await page.getByRole('button', {name:'Favorites', exact:true}).click();
  await expect(page.locator('.library-work-open strong', {hasText: title!})).toBeVisible();
  await page.reload();
  await expect(page.locator('.library-work-open strong', {hasText: title!})).toBeVisible();
  await page.getByRole('button', {name:'List view'}).click();
  await expect(page.locator('.library-work-details').first()).toContainText(/Not started|Finished|ebook|Chapter|Downloading/);
});

test('upgrade maps edition favorites and preserves device records', async ({ page }) => {
  const works = await (await page.request.get('/api/library')).json();
  const work = works.find((entry: {recordings: {id?: string; audioEditionId?: string}[]}) => entry.recordings.length);
  expect(work).toBeTruthy();
  await page.goto('/build.json');
  await page.evaluate(async (workId: string) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('sonder', 60);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('books', {keyPath:'id'});
        db.createObjectStore('progress', {keyPath:'recordingId'});
        db.createObjectStore('preferences', {keyPath:'key'});
        db.createObjectStore('downloads', {keyPath:'trackId'}).createIndex('recordingId', 'recordingId');
        db.createObjectStore('downloadParts', {keyPath:'trackId'}).createIndex('recordingId', 'recordingId');
        db.createObjectStore('downloadChunks', {keyPath:['trackId','offset']}).createIndex('trackId', 'trackId');
        db.createObjectStore('positionHistory', {keyPath:'recordingId'});
        db.createObjectStore('works', {keyPath:'workId'});
        db.createObjectStore('keep', {keyPath:'workId'});
      };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['books','progress','preferences','downloads','positionHistory'], 'readwrite');
      tx.objectStore('books').put({id:'old-edition', workId});
      tx.objectStore('preferences').put({key:'favorites', value:['old-edition','unknown']});
      tx.objectStore('progress').put({recordingId:'old', trackId:'track', position:12, duration:100, updatedAt:1});
      tx.objectStore('downloads').put({trackId:'track', recordingId:'old', name:'track', size:1, storage:'idb', completedAt:Date.now(), blob:new Blob(['x'])});
      tx.objectStore('positionHistory').put({recordingId:'old', entries:[]});
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, work.workId);
  await page.goto('/#library');
  await page.getByRole('button', {name:'Favorites', exact:true}).click();
  await expect(page.locator('.library-work-open strong', {hasText:work.title})).toBeVisible();
  const result = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('sonder'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const get = (store: string, key: string) => new Promise<any>((resolve, reject) => { const req = db.transaction(store).objectStore(store).get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const values = await Promise.all([get('preferences','favorites'), get('preferences','workFavorites'), get('progress','old'), get('downloads','track'), get('positionHistory','old')]);
    db.close(); return values;
  });
  expect(result[0].value).toEqual(['old-edition','unknown']);
  expect(result[1].value).toEqual([work.workId]);
  expect(result[2].position).toBe(12);
  expect(result[3].recordingId).toBe('old');
  expect(result[4].recordingId).toBe('old');
});
