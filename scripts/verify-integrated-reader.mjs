// Exercise the deployed reader with real audio; isolate preferences and protect progress.
import fs from 'node:fs';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:25000});
process.loadEnvFile('.env');
const recordingId=process.argv[2];
if(!recordingId)throw Error('Usage: node scripts/verify-integrated-reader.mjs recording-id');
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'});
const context=await browser.newContext({baseURL:process.env.SONDER_VERIFY_URL || 'https://sonder.pecori.no',viewport:{width:390,height:844},serviceWorkers:'block'});
const report={recordingId,protectedWrites:0,checks:[],errors:[]};
let page;
try {
 const login=await context.request.post('/api/auth/login',{data:{password:process.env.APP_PASSWORD}});if(!login.ok())throw Error('Sign-in failed');
 const books=await(await context.request.get('/api/books')).json(),book=books.find(b=>b.recordingId===recordingId);if(!book)throw Error('Recording not found');
 const ebooks=(await(await context.request.get('/api/ebooks')).json()).filter(e=>e.workId===book.workId&&e.format==='epub'&&e.available);
 let ebook,map;
 for(const item of ebooks){
  const jobs=await(await context.request.get('/api/alignments?ebookId='+encodeURIComponent(item.id))).json();
  const job=jobs.jobs.find(j=>j.recordingId===recordingId&&j.progress===1&&j.intervals.length);
  if(job){const response=await context.request.get(`/api/alignments/${job.id}/map`);if(response.ok()){ebook=item;map=await response.json();break;}}
 }
 if(!map)throw Error('Prepare a reading-sync map for this recording first');
 const appearance=await(await context.request.get('/api/appearance')).json();
 await context.addInitScript(({appearance,ebook,workId})=>{
  localStorage.setItem('sonder-appearance-device','true');localStorage.setItem('sonder-appearance',JSON.stringify({...appearance,playback:{progressScope:'book'},reader:{...appearance.reader,display:'book',segmentWords:30}}));
  localStorage.setItem(`reader-ebook:${workId}`,ebook);
  const Native=window.Audio;window.__audio=[];window.Audio=class extends Native{constructor(...args){super(...args);window.__audio.push(this);}};
 },{appearance,ebook:ebook.id,workId:book.workId});
 await context.route('**/api/progress',async route=>{report.protectedWrites++;await route.fulfill({json:{progress:route.request().postDataJSON()}});});
 await context.route('**/api/reader/*/progress',async route=>{report.protectedWrites++;const data=route.request().postDataJSON();await route.fulfill({json:{checkpoint:{...data,revision:(data.baseRevision||0)+1}}});});
 await context.route('**/api/appearance',route=>{if(route.request().method()==='PUT')throw Error('QA preferences must stay device-only');return route.continue();});
 page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 const actual=()=>page.evaluate(()=>{const a=window.__audio.find(a=>a.src);return a&&{position:a.currentTime,paused:a.paused,ready:a.readyState,error:a.error?.message};});
 await page.goto('/');
 const dockBook=await page.locator('.dock-cover-button').getAttribute('aria-label');
 if(dockBook?.includes(book.title) && book.progress){
  await page.getByRole('button',{name:'Open ebook reader',exact:true}).click();
  await expect.poll(async()=>{const a=await actual();return a&&a.ready>=1&&a.paused;},{timeout:30000}).toBe(true);
  expect(Math.abs((await actual()).position-book.progress.position)).toBeLessThan(10);
  await expect(page.locator('.inline-reader .reader-viewport iframe')).toBeVisible();
  report.checks.push({name:'Opening reader restores the saved position without starting playback'});
  await page.getByRole('dialog',{name:'Now playing',exact:true}).getByRole('button',{name:'Close dialog',exact:true}).click();
 }
 await page.getByRole('button',{name:`About ${book.title}`,exact:true}).first().click();
 const detail=page.getByRole('dialog',{name:'Book details',exact:true});
 const releases=detail.getByRole('combobox',{name:'Audiobook release',exact:true});if(await releases.count())await releases.selectOption(book.id);
 await detail.getByRole('button',{name:/^(Continue listening|Start listening)$/}).click();
 await expect.poll(async()=>{const a=await actual();return a&&a.ready>=2&&!a.paused&&!a.error;},{timeout:30000}).toBe(true);
 await detail.getByRole('button',{name:'Pause',exact:true}).click();await detail.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.locator('.dock-book').click();
 await expect(page.getByRole('dialog',{name:'Now playing',exact:true})).toBeVisible();
 await expect(page.locator('.inline-reader .reader-viewport iframe')).toBeVisible();
 await expect(page.getByRole('button',{name:'Playback options',exact:true})).toHaveAttribute('aria-expanded','false');
 const surface=await page.getByRole('dialog',{name:'Now playing',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor);
 await expect(page.frameLocator('.reader-viewport iframe').locator('body')).toHaveCSS('background-color',surface);
 const readerBox=await page.locator('.reader-viewport').boundingBox();if(readerBox.height<844*.65)throw Error('Reader is too small on mobile');
 await page.getByRole('button',{name:'Playback options',exact:true}).click();
 await expect(page.getByRole('button',{name:'Back to narration',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Versions & sources',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Search this book',exact:true})).toBeVisible();
 await page.screenshot({path:'artifacts/live-reader-options-mobile.png'});
 await page.getByRole('button',{name:'Close playback options',exact:true}).click();
 report.checks.push({name:'EPUB visible by default in Now Playing',ebookId:ebook.id});
 const slider=page.getByRole('slider',{name:'Seek in audiobook',exact:true});
 const samples=[];
 for(const pair of [map.pairings[0],map.pairings[Math.floor(map.pairings.length/2)],map.pairings.at(-1)]){
  const choices=map.intervals.filter(i=>i.section===pair.section&&i.end-i.start>4);
  const interval=choices[Math.floor(choices.length/2)];if(!interval)throw Error('No test passage in section');
  const position=Math.floor(interval.end)-1;
  await slider.fill(String(position));
  await expect(page.locator('.inline-reader')).toHaveAttribute('data-current-passage',interval.paragraphId);
  await expect(page.locator('.reader-viewport .sonder-follow').first()).toBeVisible();
  await expect.poll(async()=>(await actual()).position).toBeCloseTo(position,0);
  if(!(await actual()).paused)throw Error('Seeking must preserve pause');
  await expect(page.locator('.toast')).toHaveCount(0);
  samples.push({section:pair.section,paragraphId:interval.paragraphId,position});
 }
 report.checks.push({name:'Paused UI seeks highlight first, middle and final sections',samples});
 await page.screenshot({path:'artifacts/live-integrated-reader-mobile.png'});
 const full=page.getByRole('dialog',{name:'Now playing',exact:true});
 const initial=await page.locator('.inline-reader').getAttribute('data-current-passage');
 await full.getByRole('button',{name:'Play',exact:true}).click();
 await expect.poll(()=>page.locator('.inline-reader').getAttribute('data-current-passage'),{timeout:20000}).not.toBe(initial);
 await full.getByRole('button',{name:'Pause',exact:true}).click();
 report.checks.push({name:'Real audio advances the highlighted passage automatically'});
 const paragraph=page.locator('.inline-reader .reader-viewport .sonder-follow').first();
 const spot=(await paragraph.boundingBox());
 await page.mouse.move(spot.x+spot.width/2,spot.y+Math.min(10,spot.height/2));await page.mouse.down();await page.waitForTimeout(800);await page.mouse.up();
 const sheet=page.getByRole('dialog',{name:'Sentence actions',exact:true});
 await expect(sheet).toBeVisible();
 await expect(sheet.getByText(/^(Estimated audio time|Audio time): (\d+:)?\d{1,2}:\d\d$/)).toBeVisible();
 await expect(sheet.getByRole('button',{name:'Listen from here',exact:true})).toBeVisible();
 await page.screenshot({path:'artifacts/live-reader-sentence-sheet-mobile.png'});
 await sheet.getByRole('button',{name:'Close sentence actions',exact:true}).click();
 report.checks.push({name:'Long-press opens sentence actions with the audio time'});
 const transport=full.locator('.player-transport-display');
 await transport.getByRole('button',{name:'Lyrics',exact:true}).click();
 await expect(page.locator('.inline-reader .lyrics-line.current')).toHaveCount(1);
 await expect(page.locator('.inline-reader .reader-viewport')).toHaveAttribute('aria-hidden','true');
 const size=await page.locator('.inline-reader .lyrics-line.current').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
 // Spacing by width (clamp 24–34 px) scaled by the reader text-size preference (19 = normal).
 const expected=Math.max(24,Math.min(34,390*.066))*(appearance.reader.size||19)/19;
 if(Math.abs(size-expected)>1)throw Error(`Lyrics text is ${size}px at 390px wide, expected ${expected.toFixed(1)}px`);
 const lines=page.locator('.inline-reader .lyrics-line');
 const current=await lines.evaluateAll(els=>els.findIndex(el=>el.classList.contains('current')));
 const before=(await actual()).position;
 await lines.nth(current+3).click();
 await expect.poll(async()=>Math.abs((await actual()).position-before),{timeout:20000}).toBeGreaterThan(1);
 await expect(lines.nth(current+3)).toHaveClass(/current/);
 await full.getByRole('button',{name:'Pause',exact:true}).click();
 await expect(page.locator('.toast')).toHaveCount(0);
 await page.screenshot({path:'artifacts/live-integrated-reader-lyrics-mobile.png'});
 report.checks.push({name:'Lyrics mode follows the narration and tapping a line seeks there',fontSize:size});
 await page.setViewportSize({width:320,height:740});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);
 expect((await slider.boundingBox()).y+44).toBeLessThanOrEqual(740);
 await page.setViewportSize({width:1440,height:1000});
 await expect(page.locator('.inline-reader .lyrics-line.current')).toBeInViewport();
 await page.screenshot({path:'artifacts/live-integrated-reader-lyrics-desktop.png'});
 await transport.getByRole('button',{name:'Page',exact:true}).click();
 await expect(page.locator('.reader-viewport .sonder-follow').first()).toBeVisible();
 await page.screenshot({path:'artifacts/live-integrated-reader-desktop.png'});
 report.checks.push({name:'Reader and transport fit narrow mobile and desktop'});
 expect(report.errors).toEqual([]);report.ok=true;
} catch(error){report.ok=false;report.failure=error.message;process.exitCode=1;await page?.screenshot({path:'artifacts/live-integrated-reader-failure.png'}).catch(()=>{});report.state=await page?.evaluate(()=>({passage:document.querySelector('.inline-reader')?.getAttribute('data-current-passage'),follow:document.querySelectorAll('.inline-reader .sonder-follow').length,backToNarration:!!document.querySelector('.reader-back-narration')})).catch(()=>null);}
finally{await context.unrouteAll({behavior:'wait'});await browser.close();fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/integrated-reader-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
