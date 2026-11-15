// Exercise the deployed reader with real audio; isolate preferences and protect progress.
import fs from 'node:fs';
import {protectBrowserMutations, closeProtectedBrowser} from './verification-safety.mjs';
import {chromium,expect as baseExpect} from '@playwright/test';
import {pickMappedIntervals,intervalMiddle} from './live-reader-samples.mjs';
import {createReaderControls,waitForBox} from './live-reader-controls.mjs';
const expect=baseExpect.configure({timeout:25000});
process.loadEnvFile('.env');
const recordingId=process.argv[2];
if(!recordingId)throw Error('Usage: node scripts/verify-integrated-reader.mjs recording-id');
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'});
const baseURL=process.env.SONDER_VERIFY_URL || 'https://sonder.pecori.no';
const context=await browser.newContext({baseURL,viewport:{width:390,height:844},serviceWorkers:'block'});
const report={recordingId,protectedWrites:0,checks:[],errors:[]};
fs.mkdirSync('artifacts',{recursive:true});
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
 await protectBrowserMutations(context,baseURL,report);
 page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 // The reader's controls toggle on a tap and reset when it remounts; every click on them goes through this helper (#413).
 const room=page.locator('.inline-reader'),controls=createReaderControls({page,room});
 const actual=()=>page.evaluate(()=>{const a=window.__audio.find(a=>a.src);return a&&{position:a.currentTime,paused:a.paused,ready:a.readyState,error:a.error?.message};});
 await page.goto('/');
 const dockBook=await page.locator('.dock-cover-button').getAttribute('aria-label');
 if(dockBook?.includes(book.title) && book.progress){
  await page.getByRole('button',{name:'Open ebook reader',exact:true}).click();
  await expect.poll(async()=>{const a=await actual();return a&&a.ready>=1&&a.paused;},{timeout:30000}).toBe(true);
  expect(Math.abs((await actual()).position-book.progress.position)).toBeLessThan(10);
  await expect(page.locator('.inline-reader .reader-viewport iframe')).toBeVisible();
  report.checks.push({name:'Opening reader restores the saved position without starting playback'});
  await controls.click(room.locator('.reader-topbar').getByRole('button',{name:'Close reader',exact:true}),'Close reader');
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
 const full=page.getByRole('dialog',{name:'Now playing',exact:true});
 // With an ebook, Now Playing is the full-screen reader with one player bar (#22).
 await expect(full.locator('.now-playing-transport')).toBeHidden();
 await expect(room.locator('.reader-topbar')).toBeHidden();
 const surface=await room.evaluate(el=>getComputedStyle(el).backgroundColor);
 await expect(page.frameLocator('.inline-reader .reader-viewport iframe').locator('body')).toHaveCSS('background-color',surface);
 const readerBox=await waitForBox(room.locator('.reader-viewport'),{description:'reader viewport'});if(readerBox.height<844*.65)throw Error('Reader is too small on mobile');
 const more=()=>controls.click(room.locator('.reader-topbar').getByRole('button',{name:'More',exact:true}),'More');
 await more();
 const options=page.getByRole('region',{name:'Playback options',exact:true});
 await expect(options.getByRole('button',{name:'Versions & sources',exact:true})).toBeVisible();
 await expect(options.getByRole('button',{name:'Listen from here',exact:true})).toBeVisible();
 await expect(options.getByRole('group',{name:'Reading mode',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Back to narration',exact:true})).toBeDisabled();
 await page.screenshot({path:'artifacts/live-reader-options-mobile.png'});
 await options.getByRole('button',{name:'Close playback options',exact:true}).click();
 report.checks.push({name:'EPUB fills Now Playing; More holds playback and reader options',ebookId:ebook.id});
 // Sample the audio element directly and check that Page mode follows.
 const seek=position=>page.evaluate(position=>{const a=window.__audio.find(a=>a.src);a.currentTime=position;},position);
 // Seeking the audio element stays within the loaded file, so sample that file's passages.
 const src=await page.evaluate(()=>window.__audio.find(a=>a.src).src);
 const loaded=book.tracks.find(t=>src.includes(encodeURIComponent(t.id))||src.includes(t.id));
 if(!loaded)throw Error('Could not tell which audio file is loaded');
 const samples=[];
 for(const interval of pickMappedIntervals(map.intervals,loaded.id)){
  const position=Math.floor(interval.end)-1;
  await seek(position);
  await expect(room).toHaveAttribute('data-current-passage',interval.paragraphId);
  await expect(page.locator('.inline-reader .reader-viewport .sonder-follow').first()).toBeVisible();
  await expect.poll(async()=>(await actual()).position).toBeCloseTo(position,0);
  if(!(await actual()).paused)throw Error('Seeking must preserve pause');
  await expect(page.locator('.toast')).toHaveCount(0);
  samples.push({section:interval.section,paragraphId:interval.paragraphId,position,middle:intervalMiddle(interval)});
 }
 if(!samples.length)throw Error('No mapped passage on the loaded audio file');
 report.checks.push({name:'Paused audio seeks move the highlighted passage',samples});
 await page.screenshot({path:'artifacts/live-integrated-reader-mobile.png'});
 // Play from the middle sample: the last one runs into unmapped closing credits.
 const middle=samples[Math.floor(samples.length/2)];
 await seek(middle.position-20);
 await expect(room).toHaveAttribute('data-current-passage',/.+/);
 const play=room.getByRole('button',{name:'Play narration',exact:true}),pause=room.getByRole('button',{name:'Pause narration',exact:true});
 const initial=await room.getAttribute('data-current-passage');
 await controls.click(play,'Play narration');
 await expect.poll(()=>room.getAttribute('data-current-passage'),{timeout:20000}).not.toBe(initial);
 await controls.click(pause,'Pause narration');
 report.checks.push({name:'Real audio advances the highlighted passage automatically'});
 // Pausing can stop inside an unsynced gap, where no sentence is highlighted by design (partially mapped books, #349).
 // Return to the middle of a sentence already proven mapped above before pressing the narrated sentence.
 await seek(middle.middle);
 await expect(room).toHaveAttribute('data-current-passage',middle.paragraphId);
 // Long-press plays the narration from that sentence; Undo returns to where it was.
 const before=(await actual()).position;
 // Press in the middle of the visible page, clear of the top bar and the player.
 await controls.hide();
 // Press the sentence being narrated: it is mapped and on screen. A fixed point on the page can land on an image or an unmapped passage (#146).
 const target=page.locator('.inline-reader .reader-viewport .sonder-follow').first();
 await expect(target,`no narrated-sentence highlight at ${(await actual()).position.toFixed(1)} s on the loaded file (mapped sample ${middle.paragraphId} at ${middle.middle.toFixed(1)} s)`).toBeVisible();
 const pressBox=await waitForBox(target,{description:'narrated-sentence highlight'});
 await page.mouse.move(pressBox.x+Math.min(pressBox.width/2,80),pressBox.y+Math.min(pressBox.height/2,10));await page.mouse.down();await page.waitForTimeout(800);await page.mouse.up();
 const toast=room.getByRole('status').filter({hasText:'Listening from here'});
 await expect(toast).toBeVisible();
 await expect.poll(async()=>!(await actual()).paused,{timeout:20000}).toBe(true);
 await page.screenshot({path:'artifacts/live-reader-listen-from-here-mobile.png'});
 await toast.getByRole('button',{name:'Undo',exact:true}).click();
 await expect.poll(async()=>Math.abs((await actual()).position-before),{timeout:20000}).toBeLessThan(3);
 await controls.click(pause,'Pause narration');
 report.checks.push({name:'Long-press listens from that sentence and Undo returns'});
 await more();
 await options.getByRole('group',{name:'Reading mode',exact:true}).getByRole('button',{name:'Lyrics',exact:true}).click();
 await expect(page.locator('.inline-reader .lyrics-line.current')).toHaveCount(1);
 await expect(page.locator('.inline-reader .reader-viewport')).toHaveAttribute('aria-hidden','true');
 const size=await page.locator('.inline-reader .lyrics-line.current').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
 // Spacing by width (clamp 24–34 px) scaled by the reader text-size preference (19 = normal).
 const expected=Math.max(24,Math.min(34,390*.066))*(appearance.reader.size||19)/19;
 if(Math.abs(size-expected)>1)throw Error(`Lyrics text is ${size}px at 390px wide, expected ${expected.toFixed(1)}px`);
 const lines=page.locator('.inline-reader .lyrics-line');
 const current=await lines.evaluateAll(els=>els.findIndex(el=>el.classList.contains('current')));
 const start=(await actual()).position;
 await lines.nth(current+3).click();
 await expect.poll(async()=>Math.abs((await actual()).position-start),{timeout:20000}).toBeGreaterThan(1);
 await expect(lines.nth(current+3)).toHaveClass(/current/);
 await controls.click(pause,'Pause narration');
 await expect(page.locator('.toast')).toHaveCount(0);
 await page.screenshot({path:'artifacts/live-integrated-reader-lyrics-mobile.png'});
 report.checks.push({name:'Lyrics mode follows the narration and tapping a line seeks there',fontSize:size});
 await page.setViewportSize({width:320,height:740});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);
 expect((await waitForBox(play,{description:'Play narration button'})).y+44).toBeLessThanOrEqual(740);
 await page.setViewportSize({width:1440,height:1000});
 // Playback after the line tap may have paused inside an unsynced gap (partially mapped books, #349); return to a proven-mapped position.
 await seek(middle.middle);
 // Wait for the current line to exist before looking at where it is. The reader catches up with the seek and the new layout on its own;
 // a seek that landed before the layout change is repeated. Nothing here scrolls the lyrics.
 const currentLine=page.locator('.inline-reader .lyrics-line.current');
 await expect.poll(async()=>{
  if(await currentLine.count()===1)return true;
  await seek(middle.middle);return false;
 },{timeout:25000,intervals:[500,1000,2000],message:`no current Lyrics line after seeking to the mapped sample ${middle.paragraphId} at ${middle.middle.toFixed(1)} s on file ${loaded.id}`}).toBe(true);
 await expect(currentLine).toBeInViewport();
 await page.screenshot({path:'artifacts/live-integrated-reader-lyrics-desktop.png'});
 await more();
 await options.getByRole('group',{name:'Reading mode',exact:true}).getByRole('button',{name:'Page',exact:true}).click();
 await expect(page.locator('.inline-reader .reader-viewport .sonder-follow').first()).toBeVisible();
 await expect(page.getByLabel('Contents sidebar')).toBeVisible();
 await expect(room.getByRole('slider',{name:/^Seek in /})).toBeVisible();
 await page.screenshot({path:'artifacts/live-integrated-reader-desktop.png'});
 report.checks.push({name:'Reader and player bar fit narrow mobile and desktop'});
 expect(report.errors).toEqual([]);report.ok=true;
} catch(error){report.ok=false;report.failure=error.message;process.exitCode=1;await page?.screenshot({path:'artifacts/live-integrated-reader-failure.png'}).catch(()=>{});report.state=await page?.evaluate(()=>({passage:document.querySelector('.inline-reader')?.getAttribute('data-current-passage'),follow:document.querySelectorAll('.inline-reader .sonder-follow').length,backToNarration:!!document.querySelector('.reader-back-narration')})).catch(()=>null);}
finally{// Close the page while its writes are still intercepted: unrouting first would let a queued progress save reach the server.
await closeProtectedBrowser(context,browser,report);fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/integrated-reader-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
