import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {protectBrowserMutations, closeProtectedBrowser} from '../scripts/verification-safety.mjs';

const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const launchOptions = existsSync(executable) ? {executablePath: executable} : {};

async function fixture() {
  const writes = [];
  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) writes.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', req.url === '/' ? 'text/html' : 'application/json');
    res.end(req.url === '/' ? '<button id="hold">Hold</button><input id="seek" type="range"><script>window.send=(url,method,data)=>fetch(url,{method,headers:{"Content-Type":"application/json"},body:data===undefined?undefined:JSON.stringify(data)}).then(r=>r.json()); let timer; hold.onpointerdown=()=>timer=setTimeout(()=>send("/api/progress","POST",{position:40}),500); hold.onpointerup=()=>clearTimeout(timer); seek.onchange=()=>send("/api/progress","POST",{position:+seek.value});</script>' : '{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({baseURL, serviceWorkers:'block'});
  const report = {protectedWrites:0, errors:[], ok:true};
  await protectBrowserMutations(context, baseURL, report);
  return {server,browser,context,baseURL,report,writes};
}
async function finish(f) {
  const previous = process.exitCode;
  await closeProtectedBrowser(f.context, f.browser, f.report);
  process.exitCode = previous;
  await new Promise(resolve => f.server.close(resolve));
}

test('browser mutations are mocked with consumer-compatible responses and unexpected writes fail closed', async () => {
  const f = await fixture();
  try {
    const page = await f.context.newPage();
    await page.goto(f.baseURL);
    const results = await page.evaluate(async () => {
      const locator={paragraphId:'p1',section:0,progression:0.2};
      const progress=await send('/api/progress','POST',{recordingId:'r',trackId:'t',position:2,duration:100,updatedAt:1});
      const checkpoint=await send('/api/reader/e/progress','PUT',{locator,baseRevision:4,eventId:'event123',deviceId:'device',updatedAt:1,origin:'reading'});
      const bookmark=await send('/api/reader/e/bookmarks','POST',{id:'bookmark1',label:'Place',locator});
      const removed=await send('/api/reader/e/bookmarks/bookmark1','DELETE');
      const appearance=await send('/api/appearance','PUT',{reader:{display:'book'}});
      const blockedPost=await fetch('/api/unknown',{method:'POST'});
      const blockedDelete=await fetch('/api/reader/e/bookmarks',{method:'DELETE'});
      const malformed=await fetch('/api/progress',{method:'POST',body:'not json'});
      return {progress,checkpoint,bookmark,removed,appearance,statuses:[blockedPost.status,blockedDelete.status,malformed.status]};
    });
    assert.equal(results.progress.progress.position, 2);
    assert.equal(results.checkpoint.checkpoint.revision, 5);
    assert.equal(results.checkpoint.checkpoint.locator.paragraphId, 'p1');
    assert.equal(results.checkpoint.checkpoint.eventId, 'event123');
    assert.deepEqual(results.bookmark, {id:'bookmark1',label:'Place',locator:{paragraphId:'p1',section:0,progression:0.2}});
    assert.deepEqual(results.removed, {ok:true});
    assert.deepEqual(results.appearance, {reader:{display:'book'}});
    assert.deepEqual(results.statuses, [403,403,400]);
    assert.equal(f.report.protectedWrites, 5);
    assert.equal(f.report.errors.length, 3);
    assert.deepEqual(f.writes, []);
  } finally { await finish(f); }
  assert.equal(f.report.ok, false);
});

test('long press, scrubbing and unload stay protected through teardown and failures', async () => {
  const f=await fixture();
  try {
    const page=await f.context.newPage();
    await page.goto(f.baseURL);
    const hold=page.locator('#hold');
    const box=await hold.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    await page.locator('#seek').fill('70');
    await page.evaluate(() => window.addEventListener('unload',()=>navigator.sendBeacon('/api/progress',new Blob([JSON.stringify({position:99})],{type:'application/json'}))));
    await page.goto(`${f.baseURL}/next`);
    await page.waitForTimeout(300);
    assert.equal(f.report.protectedWrites, 2);
    assert.deepEqual(f.writes, []);
    // Keepalive and beacons can bypass routing, so both are suppressed in-page.
    await page.goto(f.baseURL);
    await page.evaluate(async () => {
      navigator.sendBeacon('/api/unknown', 'x');
      await fetch('/api/unknown', {method:'POST', keepalive:true});
    });
    await page.waitForTimeout(100);
    assert.equal(f.report.errors.length, 1);
    assert.deepEqual(f.writes, []);
    // Simulate the verifier's failure path while an unload write is queued.
    await page.goto(f.baseURL);
    await page.evaluate(() => window.addEventListener('beforeunload',()=>navigator.sendBeacon('/api/unexpected-on-unload', 'x')));
    f.report.ok=false;
    // closeProtectedBrowser closes this page and drains its unload ledger.
  } finally { await finish(f); }
  assert.deepEqual(f.writes, []);
  assert.equal(f.report.errors.length, 4);
  assert.ok(f.report.errors.some(error => error.includes('/api/unexpected-on-unload')));
});

test('guard remains installed while context.close drains pending writes', async () => {
  const f = await fixture();
  try {
    const page = await f.context.newPage();
    await page.goto(f.baseURL);
    const close = f.context.close.bind(f.context);
    f.context.close = async () => {
      const result = await f.context.pages()[0].evaluate(() => fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({position:123})}).then(r=>r.json()));
      assert.equal(result.progress.position,123);
      await close();
    };
  } finally { await finish(f); }
  assert.equal(f.report.protectedWrites,1);
  assert.deepEqual(f.writes,[]);
});
