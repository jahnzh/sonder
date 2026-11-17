// Exercise the deployed reader with real audio; isolate preferences and protect progress.
import fs from 'node:fs';
import {protectBrowserMutations, closeProtectedBrowser} from './verification-safety.mjs';
import {chromium,expect as baseExpect} from '@playwright/test';
import {createReaderControls,narratedOnPage,waitForBox} from './live-reader-controls.mjs';
import {verifyBaseURL} from './live-check-target.mjs';
import {selectReaderRecording,requestFrom,getJSON,NoSuitableRecording,NO_SUITABLE_RECORDING_EXIT,FOLLOW_WAIT_SECONDS} from './live-check-recording.mjs';
const expect=baseExpect.configure({timeout:25000});
process.loadEnvFile('.env');
// The recording id is a preference: the check plays it when it qualifies and otherwise picks another (#431).
const preferred=process.argv[2]||null;
const baseURL=verifyBaseURL();
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'});
const context=await browser.newContext({baseURL,viewport:{width:390,height:844},serviceWorkers:'block'});
const report={recordingId:null,preferred,protectedWrites:0,checks:[],errors:[]};
fs.mkdirSync('artifacts',{recursive:true});
let page;
try {
 const login=await context.request.post('/api/auth/login',{data:{password:process.env.APP_PASSWORD}});if(!login.ok())throw Error(`Sign-in failed (POST /api/auth/login answered ${login.status()})`);
 // Choose the recording and map from the listing: playback starts at the owner's saved position, which this check must not move.
 // Only an empty listing or a 404/410 map can lead to "no suitable recording"; any other failed request fails the check (#431).
 // A recording chosen here that then fails below stays a failure: the check does not fall through to another one.
 const get=requestFrom(context);
 const pick=await selectReaderRecording(get,{preferred});
 const {book,ebook,sequence}=pick;
 report.recordingId=pick.recordingId;report.selection={ebookId:ebook.id,jobId:pick.job.id,start:sequence.start,follow:sequence.follow,...(pick.preferred?{preferred:pick.preferred}:{})};
 const appearance=await getJSON(get,'/api/appearance');
 await context.addInitScript(({appearance,ebook,workId})=>{
  localStorage.setItem('sonder-appearance-device','true');localStorage.setItem('sonder-appearance',JSON.stringify({...appearance,playback:{progressScope:'book'},reader:{...appearance.reader}}));
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
 // The reader shows the book's own text only: there is no switch between views (ADR 0017).
 await expect(options.getByRole('group',{name:'Reading mode',exact:true})).toHaveCount(0);
 for(const name of ['Page','Lyrics','Word'])await expect(options.getByRole('button',{name,exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Back to narration',exact:true})).toBeDisabled();
 await page.screenshot({path:'artifacts/live-reader-options-mobile.png'});
 await options.getByRole('button',{name:'Close playback options',exact:true}).click();
 report.checks.push({name:'EPUB fills Now Playing; More holds playback and reader options and no view switch',ebookId:ebook.id});
 // Sample the audio element directly and check that Page mode follows.
 const seek=position=>page.evaluate(position=>{const a=window.__audio.find(a=>a.src);a.currentTime=position;},position);
 // Seeking the audio element stays within the loaded file: the file of the saved position, whose passages the sequence samples.
 const src=await page.evaluate(()=>window.__audio.find(a=>a.src).src);
 const loaded=book.tracks.find(t=>src.includes(encodeURIComponent(t.id))||src.includes(t.id));
 if(!loaded)throw Error('Could not tell which audio file is loaded');
 if(loaded.id!==sequence.trackId)throw Error(`The loaded audio file is ${loaded.id}, not ${sequence.trackId} of the saved position`);
 // Where to seek and play comes from readerSequence (scripts/live-check-recording.mjs), which also chose this map.
 const samples=[];
 for(const sample of sequence.samples){
  await seek(sample.position);
  await expect(room).toHaveAttribute('data-current-passage',sample.paragraphId);
  await expect(page.locator('.inline-reader .reader-viewport .sonder-follow').first()).toBeVisible();
  await expect.poll(async()=>(await actual()).position).toBeCloseTo(sample.position,0);
  if(!(await actual()).paused)throw Error('Seeking must preserve pause');
  await expect(page.locator('.toast')).toHaveCount(0);
  samples.push(sample);
 }
 if(!samples.length)throw Error('No mapped passage on the loaded audio file');
 report.checks.push({name:'Paused audio seeks move the highlighted passage',samples});
 await page.screenshot({path:'artifacts/live-integrated-reader-mobile.png'});
 // Play from a highlighted passage shortly before another begins, away from the end of the file.
 const middle=sequence.middle,follow=sequence.follow;
 await seek(follow.start);
 await expect(room).toHaveAttribute('data-current-passage',follow.passage);
 // Look for Play/Pause inside the player bar only: a role query over the whole reader took seconds per read in a long book (#413).
 const player=room.locator('.reader-player'),play=player.getByRole('button',{name:'Play narration',exact:true}),pause=player.getByRole('button',{name:'Pause narration',exact:true});
 const initial=await room.getAttribute('data-current-passage');
 await controls.click(play,'Play narration');
 await expect.poll(()=>room.getAttribute('data-current-passage'),{timeout:FOLLOW_WAIT_SECONDS*1000,message:`the highlighted passage stayed ${initial} after playing from ${follow.start.toFixed(1)} s (next passage ${follow.next} at ${follow.nextAt.toFixed(1)} s)`}).not.toBe(initial);
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
 // Undo is the foot's message action (#591).
 await room.locator('.reader-message').getByRole('button',{name:'Undo',exact:true}).click();
 await expect.poll(async()=>Math.abs((await actual()).position-before),{timeout:20000}).toBeLessThan(3);
 await controls.click(pause,'Pause narration');
 report.checks.push({name:'Long-press listens from that sentence and Undo returns'});
 // F returns to the narration from a page that does not show it (#501 review): page forward until the narrated
 // sentence is off the page, then F. The page turns save a reading place, which is intercepted like every write.
 // Undo may have played on a little before the pause; put the narration back on the proven-mapped sentence.
 await seek(middle.middle);
 await expect.poll(async()=>(await actual()).position).toBeCloseTo(middle.middle,0);
 await expect(room).toHaveAttribute('data-current-passage',middle.paragraphId);
 await expect.poll(()=>narratedOnPage(room),{message:`the narrated sentence ${middle.paragraphId} is not on the page before paging away`}).toBe(true);
 await controls.hide();
 // A long sentence can run on to the next page: turn until none of it is on the page, at most three times.
 for(let turns=0;turns<3&&await narratedOnPage(room);turns++){await controls.turn('next');await page.waitForTimeout(600);}
 await expect(room).not.toHaveAttribute('data-current-passage',/.+/);
 await expect.poll(()=>narratedOnPage(room),{message:`the narrated sentence ${middle.paragraphId} is still on the page after three page turns`}).toBe(false);
 await page.keyboard.press('f');
 await expect(room).toHaveAttribute('data-current-passage',middle.paragraphId);
 await expect.poll(()=>narratedOnPage(room),{message:`F did not bring the page of the narrated sentence ${middle.paragraphId} back`}).toBe(true);
 report.checks.push({name:'F brings the narrated sentence back on the page after paging away'});
 // Search and Bookmarks are pages of the book (#590): a result opens the reader there, paged away, Back to narration
 // returns to the narration, and Back from the reader shows the words and results again. Nothing here writes a bookmark.
 const manifest=await getJSON(get,`/api/reader/${encodeURIComponent(ebook.id)}`);
 const narratedText=manifest.sections.flatMap(section=>section.paragraphs).find(fragment=>fragment.id===middle.paragraphId)?.text||'';
 const words=narratedText.trim().split(/\s+/).slice(0,6).join(' ');
 if(words.length<2)throw Error(`The narrated sentence ${middle.paragraphId} has no words to search for`);
 await controls.click(room.locator('.reader-topbar').getByRole('button',{name:'Search this book',exact:true}),'Search this book');
 await expect(page.getByRole('heading',{level:1,name:'Search',exact:true})).toBeVisible();
 const field=page.getByRole('searchbox',{name:'Search this book',exact:true});
 await field.fill(words);
 await expect(page.locator('.reader-pages-count')).toHaveText(/^\d+ sentences?$/);
 await page.screenshot({path:'artifacts/live-reader-search-mobile.png'});
 await page.locator('.reader-pages-result').filter({hasText:words}).first().click();
 await expect(full).toBeVisible();
 await expect(room).not.toHaveAttribute('data-current-passage',/.+/);
 await controls.click(room.getByRole('button',{name:'Back to narration',exact:true}),'Back to narration');
 await expect(room).toHaveAttribute('data-current-passage',middle.paragraphId);
 await page.goBack();
 await expect(field).toHaveValue(words);
 await expect(page.locator('.reader-pages-count')).toHaveText(/^\d+ sentences?$/);
 await page.getByRole('button',{name:'Back to the book',exact:true}).click();
 await expect(full).toBeVisible();
 await controls.click(room.locator('.reader-player').getByRole('button',{name:'Chapters',exact:true}),'Chapters');
 await expect(page.getByRole('heading',{level:1,name:'Chapters',exact:true})).toBeVisible();
 await page.getByRole('radio',{name:'Bookmarks',exact:true}).click();
 await expect(page.getByRole('heading',{level:1,name:'Bookmarks',exact:true})).toBeVisible();
 await page.screenshot({path:'artifacts/live-reader-bookmarks-mobile.png'});
 await page.getByRole('button',{name:'Back to the book',exact:true}).click();
 await expect(full).toBeVisible();
 await expect(room).toHaveAttribute('data-current-passage',middle.paragraphId);
 report.checks.push({name:'Search and Bookmarks open as pages; a result opens the reader there and Back to narration returns'});
 await page.setViewportSize({width:320,height:740});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);
 expect((await waitForBox(play,{description:'Play narration button'})).y+44).toBeLessThanOrEqual(740);
 await page.setViewportSize({width:1440,height:1000});
 // Return to a proven-mapped position (partially mapped books, #349). The reader catches up with the seek and the new
 // layout on its own; a seek that landed before the layout change is repeated. Nothing here scrolls the pages.
 await seek(middle.middle);
 const narrated=page.locator('.inline-reader .reader-viewport .sonder-follow');
 await expect.poll(async()=>{
  if(await room.getAttribute('data-current-passage')===middle.paragraphId&&await narrated.count()>0)return true;
  await seek(middle.middle);return false;
 },{timeout:25000,intervals:[500,1000,2000],message:`no narrated-sentence highlight after seeking to the mapped sample ${middle.paragraphId} at ${middle.middle.toFixed(1)} s on file ${loaded.id}`}).toBe(true);
 // On the page the reader shows, not only rendered somewhere in the chapter's columns.
 await expect.poll(()=>narratedOnPage(room),{message:`the narrated sentence ${middle.paragraphId} is not on the page after the desktop resize`}).toBe(true);
 await expect(page.getByLabel('Contents sidebar')).toBeVisible();
 await expect(room.getByRole('slider',{name:/^Seek in /})).toBeVisible();
 await page.screenshot({path:'artifacts/live-integrated-reader-desktop.png'});
 report.checks.push({name:'Reader and player bar fit narrow mobile and desktop'});
 expect(report.errors).toEqual([]);report.ok=true;
} catch(error){
 // Nothing to run on is a result of its own, not a failure: no page was opened, so nothing could write (#431).
 if(error instanceof NoSuitableRecording){report.ok=null;report.skipped=error.reason;process.exitCode=NO_SUITABLE_RECORDING_EXIT;console.log(error.message);if(process.env.SONDER_LIVE_CHECK_SKIP_FILE)fs.writeFileSync(process.env.SONDER_LIVE_CHECK_SKIP_FILE,error.reason);}
 else{report.ok=false;report.failure=error.message;process.exitCode=1;await page?.screenshot({path:'artifacts/live-integrated-reader-failure.png'}).catch(()=>{});report.state=await page?.evaluate(()=>({passage:document.querySelector('.inline-reader')?.getAttribute('data-current-passage'),follow:document.querySelectorAll('.inline-reader .sonder-follow').length,backToNarration:!!document.querySelector('.reader-back-narration')})).catch(()=>null);}}
finally{// Close the page while its writes are still intercepted: unrouting first would let a queued progress save reach the server.
await closeProtectedBrowser(context,browser,report);fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/integrated-reader-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
