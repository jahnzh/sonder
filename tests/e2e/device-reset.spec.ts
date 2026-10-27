import { test, expect } from "@playwright/test";

test("reset refreshes the app shell while preserving device data", async ({ page }) => {
  await page.goto("/#settings");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.evaluate(async () => {
    localStorage.setItem("sonder-reset-test", "keep");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["preferences", "downloadParts", "downloadChunks"], "readwrite");
      tx.objectStore("preferences").put({key:"reset-test",value:"keep"});
      tx.objectStore("downloadParts").put({trackId:"reset-test",recordingId:"reset-test",loaded:4,total:8,mime:"audio/mpeg",version:"v1"});
      tx.objectStore("downloadChunks").put({trackId:"reset-test",offset:0,blob:new Blob(["test"])});
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await caches.open("sonder-shell-test-stale");
    await caches.open("sonder-stream-test-stale");
    await caches.open("another-app-test");
  });
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", {name:"Reset app on this device"}).click(),
  ]);
  await expect(page.getByRole("heading", {name:"Settings",exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(async()=>{
    const keys=await caches.keys();
    return !keys.includes("sonder-shell-test-stale") && !keys.includes("sonder-stream-test-stale");
  })).toBe(true);
  const state=await page.evaluate(async()=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open("sonder");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const value=await new Promise<any>((resolve,reject)=>{const r=db.transaction("preferences").objectStore("preferences").get("reset-test");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const part=await new Promise<any>((resolve,reject)=>{const r=db.transaction("downloadParts").objectStore("downloadParts").get("reset-test");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const chunk=await new Promise<any>((resolve,reject)=>{const r=db.transaction("downloadChunks").objectStore("downloadChunks").get(["reset-test",0]);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    db.close();
    return {local:localStorage.getItem("sonder-reset-test"), stored:value?.value, loaded:part?.loaded, chunk:await chunk.blob.text(), other:(await caches.keys()).includes("another-app-test")};
  });
  expect(state).toEqual({local:"keep",stored:"keep",loaded:4,chunk:"test",other:true});
});

test("reset leaves the offline shell intact when the server cannot be reached", async ({ page, context }) => {
  await page.goto("/#settings");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.evaluate(()=>caches.open("sonder-shell-offline-test"));
  await context.setOffline(true);
  await page.getByRole("button",{name:"Reset app on this device"}).click();
  await expect(page.getByText("Could not reset the app. Check your connection and try again.")).toBeVisible();
  expect(await page.evaluate(async()=>(await caches.keys()).includes("sonder-shell-offline-test"))).toBe(true);
  await context.setOffline(false);
});
