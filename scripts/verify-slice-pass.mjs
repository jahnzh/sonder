// The slice finals' pass by hand, scripted (#794): walk the lists of #583 and #596 on the deployed app at a phone's
// 390 by 844 and a desktop's 1280 by 800, write a screenshot of each step and a JSON report to artifacts/.
//
// - Target: SONDER_VERIFY_URL first; production is refused without SONDER_VERIFY_PRODUCTION=1 (live-check-target.mjs).
// - Never writes: every page runs under the write guard (verification-safety.mjs); a write the app makes is answered
//   in the browser and counted (`protectedWrites`), any other is blocked and fails the check. The only direct requests
//   are GETs (the listings the choosers read) and the sign-in.
// - Never plays the owner's recent books: the book read with narration comes from selectReaderRecording (not listened
//   to in the last 48 h, #774; SONDER_VERIFY_RECORDING / the first argument as a preference), the ebook-only book from
//   ebookOnlyWork (live-check-recording.mjs).
// - Read's controls are shown before any of them is used (createReaderControls), and every click is on a shown match
//   (`shown`): the hand-scripted passes timed out on hidden duplicates.
// Exit codes: 0 every item passed, 1 a step failed, 3 no recording to read with narration (deploy.sh reports a skip).
// `runSlicePass` is exported so tests/e2e/slice-pass.spec.ts runs the same walk against the suite's server.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect as baseExpect} from '@playwright/test';
import {protectBrowserMutations,closeProtectedBrowser} from './verification-safety.mjs';
import {createReaderControls,narratedOnPage,narratedPressPoint,shown} from './live-reader-controls.mjs';
import {verifyBaseURL} from './live-check-target.mjs';
import {selectReaderRecording,requestFrom,getJSON,ebookOnlyWork,NoSuitableRecording,NO_SUITABLE_RECORDING_EXIT,verifyChoice} from './live-check-recording.mjs';
const expect=baseExpect.configure({timeout:25000});

export const SLICE_PASS_SIZES=Object.freeze([{name:'phone',width:390,height:844},{name:'desktop',width:1280,height:800}]);
export const OFFLINE_TEXT='No connection · Books on this device still play';
// The Settings pages by address (src/settings-list.ts); someone who is not the administrator has only some of them.
export const SETTINGS_PAGES=Object.freeze([['account','Account'],['appearance','Appearance'],['playback','Playback'],['connections','Connections'],['users','Users'],['library','Library and storage'],['app','App']]);

const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/**
 * Walk the slice pass. `browser` is a Playwright Browser; `prepareContext(context)` (optional) runs after the guard is
 * installed and before the first page (the suite's spec answers AudioBookBay's search there). Fills and returns `report`.
 */
export async function runSlicePass({browser,baseURL,out='artifacts',preferred=null,allowRecent=false,preferredEbookWork=null,sizes=SLICE_PASS_SIZES,password=null,prepareContext=null,report={}}){
 Object.assign(report,{baseURL:new URL(baseURL).origin,protectedWrites:0,checks:[],skipped:[],screenshots:[],writes:[],errors:[]});
 fs.mkdirSync(out,{recursive:true});
 const newContext=async(size)=>{
  const context=await browser.newContext({baseURL,viewport:{width:size.width,height:size.height},serviceWorkers:'block'});
  if(password){const login=await context.request.post('/api/auth/login',{data:{password}});if(!login.ok())throw Error(`Sign-in failed (POST /api/auth/login answered ${login.status()})`);}
  return context;
 };
 // The choosers read the listings once, before any page opens.
 const setup=await newContext(sizes[0]);
 let pick,ebookOnly,appearance;
 try{
  const get=requestFrom(setup);
  pick=await selectReaderRecording(get,{preferred,allowRecent});
  ebookOnly=ebookOnlyWork(await getJSON(get,'/api/library'),pick.listing.books,{preferred:preferredEbookWork});
  appearance=await getJSON(get,'/api/appearance');
 }finally{await setup.close();}
 const {book,ebook,sequence}=pick;
 report.selection={recordingId:pick.recordingId,workId:book.workId,title:book.title,ebookId:ebook.id,jobId:pick.job.id,...(pick.preferred?{preferred:pick.preferred}:{}),ebookOnly:ebookOnly.work?{workId:ebookOnly.work.workId,title:ebookOnly.work.title,ebookId:ebookOnly.ebookId}:{skipped:ebookOnly.reason}};
 const middle=sequence.middle;
 for(const size of sizes){
  const context=await newContext(size);
  await context.addInitScript(({appearance,ebook,workId})=>{
   // Not on about:blank (the ebook-only step loads the app afresh through it), which has no storage.
   if(!location.protocol.startsWith('http'))return;
   // Appearance stays on this device, so nothing the panel does is meant for the server (it is guarded anyway).
   localStorage.setItem('sonder-appearance-device','true');localStorage.setItem('sonder-appearance',JSON.stringify({...appearance,playback:{progressScope:'book'},reader:{...appearance.reader}}));
   localStorage.setItem(`reader-ebook:${workId}`,ebook);
   const Native=window.Audio;window.__audio=[];window.Audio=class extends Native{constructor(...args){super(...args);window.__audio.push(this);}};
  },{appearance,ebook:ebook.id,workId:book.workId});
  await protectBrowserMutations(context,baseURL,report);
  if(prepareContext)await prepareContext(context);
  const page=await context.newPage();
  page.on('pageerror',e=>report.errors.push(`${size.name}: ${e.message}`));
  // Every write the page sends; the guard answers each one in the browser (or blocks it and reports an error).
  page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))report.writes.push(`${size.name}: ${r.method()} ${new URL(r.url()).pathname}`);});
  const step=async(name,run,details={})=>{
   try{await run();report.checks.push({size:size.name,name,...details});}
   catch(error){report.errors.push(`${size.name} · ${name}: ${error.message}`);await snap(`failure-${name}`).catch(()=>{});}
  };
  const snap=async(name)=>{
   const file=path.join(out,`slice-pass-${size.name}-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}.png`);
   await page.screenshot({path:file});report.screenshots.push(file);
  };
  try{
   await walkPlaces({page,context,size,book,snap,step});
   await walkRead({page,size,book,ebook,sequence,middle,snap,step,report});
   if(ebookOnly.work)await step('An ebook-only book on Read with its slider and no narration',()=>walkEbookOnly({page,work:ebookOnly.work,snap}),{workId:ebookOnly.work.workId});
   else report.skipped.push({size:size.name,name:'An ebook-only book on Read',reason:ebookOnly.reason});
  }finally{
   // Close the pages while their writes are still guarded (closeProtectedBrowser closes the browser: not here).
   try{if(context.__verificationDrain)await context.__verificationDrain();}catch(error){report.errors.push(`Beacon audit: ${error.message}`);}
   await context.close().catch(error=>report.errors.push(`Context close: ${error.message}`));
  }
 }
 report.ok=report.errors.length===0;
 return report;
}

// Discover, a Book page, the Get sheet, the Library's chips and Shelf, each Settings page and the offline line (#583).
async function walkPlaces({page,context,size,book,snap,step}){
 const discover=page.getByRole('region',{name:'Discover',exact:true});
 const field=discover.getByRole('searchbox',{name:'Search for a book',exact:true});
 const onServer=discover.getByRole('list',{name:'On the server',exact:true}).locator('li > button').filter({hasText:book.title});
 await step('Discover search',async()=>{
  await page.goto('/#discover');
  await field.fill(book.title);await field.press('Enter');
  await expect(shown(onServer).first()).toBeVisible();
  await snap('discover-results');
 },{words:book.title});
 await step('The Get sheet opened and closed',async()=>{
  const row=shown(discover.getByRole('button',{name:/^Search for a recording/}));
  if(!(await row.count()))throw Error('no "Search for a recording" row: the check runs as the administrator');
  await row.first().click();
  const sheet=page.getByRole('dialog',{name:'Get audiobook',exact:true});
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('searchbox',{name:'Search for a recording'})).toHaveValue(book.title);
  await snap('get-sheet');
  await shown(sheet.getByRole('button',{name:'Close',exact:true})).first().click();
  await expect(sheet).toBeHidden();
  await expect(field).toHaveValue(book.title);
 });
 await step('A Book page',async()=>{
  await shown(onServer).first().click();
  await expect.poll(()=>page.evaluate(()=>decodeURIComponent(location.hash))).toBe(`#book/${book.workId}`);
  const bookPage=page.getByRole('region',{name:'Book',exact:true});
  await expect(bookPage.getByRole('heading',{level:1})).toHaveText(book.title);
  await snap('book-page');
 });
 await step('Library chips',async()=>{
  await page.goto('/#library');
  const chips=page.getByRole('group',{name:'Filter your library',exact:true}).getByRole('button');
  await expect(chips.first()).toBeVisible();
  const names=await chips.allInnerTexts();
  for(const [index,name] of names.entries()){
   await chips.nth(index).click();
   await expect(chips.nth(index)).toHaveAttribute('aria-pressed','true');
   if(index===1)await snap('library-chip');
  }
  await chips.first().click();
  await expect(chips.first()).toHaveAttribute('aria-pressed','true');
  await snap('library');
 });
 await step('The Shelf picker',async()=>{
  const control=shown(page.getByRole('button',{name:/^Sort and view: /}));
  await control.click();
  const picker=page.getByRole('dialog',{name:'Sort and view',exact:true});
  await expect(picker).toBeVisible();
  await picker.getByRole('button',{name:/^Shelf: /}).click();
  await picker.getByRole('radiogroup',{name:'Shelf',exact:true}).getByRole('radio',{name:'Want to read',exact:true}).click();
  await expect(picker.getByRole('button',{name:/^Shelf: Want to read$/})).toBeVisible();
  await snap('shelf-picker');
  await picker.getByRole('button',{name:'Done',exact:true}).click();
  await expect(picker).toHaveCount(0);
  const clear=shown(page.getByRole('button',{name:/^Clear the shelf: Want to read$/}));
  await expect(clear).toBeVisible();
  await snap('shelf-want-to-read');
  await clear.click();
  await expect(clear).toHaveCount(0);
 });
 const title=size.width>=760?page.locator('#settings-page-title'):page.getByRole('heading',{level:1});
 for(const [word,name] of SETTINGS_PAGES){
  await step(`Settings › ${name}`,async()=>{
   await page.goto('/#settings');
   const row=page.getByRole('navigation',{name:'Settings',exact:true}).getByRole('button',{name:new RegExp(`^${escape(name)}(\\s|$)`)});
   await expect(row.first()).toBeVisible();
   await row.first().click();
   await expect(title).toHaveText(name);
   await snap(`settings-${word}`);
  });
 }
 await step('The offline line',async()=>{
  await page.goto('/#library');
  const line=page.locator('.offline-line');
  await expect(page.getByRole('navigation',{name:'Main',exact:true})).toBeVisible();
  await context.setOffline(true);
  try{
   await expect(line).toHaveText(OFFLINE_TEXT);
   await snap('offline');
  }finally{await context.setOffline(false);}
  await expect(line).toHaveCount(0);
 });
}

// Read in Now playing (#596): a tap that moves nothing, Appearance with the narrated sentence kept, the sleep timer from
// the foot, Search and a bookmark and Back to narration, a long-press with Undo, the face remembered across a reopen.
async function walkRead({page,size,book,ebook,sequence,middle,snap,step,report}){
 const full=page.getByRole('dialog',{name:'Now playing',exact:true});
 const room=page.locator('.inline-reader'),head=room.locator('.reader-topbar'),foot=room.locator('.reader-player');
 const controls=createReaderControls({page,room});
 const audio=()=>page.evaluate(()=>{const a=window.__audio.find(a=>a.src);return a&&{position:a.currentTime,paused:a.paused,ready:a.readyState,src:a.src};});
 const seek=position=>page.evaluate(position=>{const a=window.__audio.find(a=>a.src);a.currentTime=position;},position);
 const pause=()=>page.evaluate(()=>window.__audio.find(a=>a.src)?.pause());
 const hash=()=>page.evaluate(()=>decodeURIComponent(location.hash));
 const onNarration=async()=>{
  await expect(room).toHaveAttribute('data-current-passage',middle.paragraphId);
  await expect.poll(()=>narratedOnPage(room),{message:`the narrated sentence ${middle.paragraphId} is not on the page`}).toBe(true);
 };
 // Read from the mini player: the face rule opens Listen the first time; its head's Read switches.
 const openFromDock=async()=>{
  await shown(page.locator('.player-dock .dock-book')).first().click();
  await expect(full).toBeVisible();
  await expect.poll(async()=>(await hash()).split('/')[0]).toMatch(/^#(listen|read)$/);
  return (await hash()).split('/')[0];
 };
 let ready=false;
 await step('Read in Now playing on the narrated sentence',async()=>{
  // The Book page's Listen plays the book's chosen recording; it is paused at once and every progress save is guarded.
  await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
  await shown(page.getByRole('region',{name:'Book',exact:true}).getByRole('button',{name:'Listen',exact:true})).click();
  await expect.poll(async()=>{const a=await audio();return !!a&&a.ready>=1;},{timeout:30000}).toBe(true);
  await pause();
  const src=(await audio()).src;
  if(!book.tracks.some(t=>decodeURIComponent(src).includes(t.id)))throw Error(`Listen played ${src}, not the selected recording ${book.recordingId}`);
  if(!decodeURIComponent(src).includes(sequence.trackId))throw Error(`The loaded file is not ${sequence.trackId}, the file of the saved position`);
  await page.evaluate(()=>{location.hash='#library';});
  await expect(full).toBeHidden();
  if(await openFromDock()==='#listen')await shown(page.locator('.now-playing-listen').getByRole('radio',{name:'Read',exact:true})).click();
  await expect.poll(hash).toBe(`#read/${book.workId}`);
  await expect(room.locator('.reader-viewport .prepared-text').first()).toBeVisible();
  await expect(room).toHaveAttribute('data-ebook',ebook.id);
  await seek(middle.middle);
  await onNarration();
  await snap('read');
  ready=true;
 },{recordingId:book.recordingId,paragraphId:middle.paragraphId});
 if(!ready)return;
 await step('A tap that moves nothing shows the controls',async()=>{
  // Where the text is: a page turn or a scroll moves the prepared text under the band (the scroller's offsets and the
  // text's box).
  const state=()=>room.evaluate(el=>{const scroller=el.querySelector('.reader-viewport .prepared-scroll'),text=el.querySelector('.reader-viewport .prepared-text')?.getBoundingClientRect();return {hash:location.hash,passage:el.getAttribute('data-current-passage'),scroll:scroller?[Math.round(scroller.scrollLeft),Math.round(scroller.scrollTop)]:null,text:text?[Math.round(text.left),Math.round(text.top)]:null};});
  if(size.width<760)await controls.hide();
  const before=await state();
  const box=await room.locator('.reader-viewport').boundingBox();
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await expect(head).toBeVisible();
  await page.waitForTimeout(500);
  expect(await state()).toEqual(before);
  await snap('read-controls');
 });
 await step('Appearance opened and closed with the narrated sentence kept',async()=>{
  await controls.click(shown(head.getByRole('button',{name:'Reader appearance',exact:true})),'Reader appearance');
  const panel=room.getByRole('region',{name:'Reader appearance',exact:true});
  await expect(panel).toBeVisible();
  await onNarration();
  await snap('appearance');
  await shown(panel.getByRole('button',{name:'Close appearance',exact:true})).click();
  await expect(panel).toHaveCount(0);
  await onNarration();
 });
 await step('The sleep timer from the foot',async()=>{
  const sleep=shown(foot.getByRole('button',{name:/^Sleep timer: /}));
  await controls.click(sleep,'Sleep timer');
  const row=foot.getByRole('group',{name:'Sleep timer',exact:true});
  const stepper=row.getByRole('spinbutton',{name:'Sleep timer',exact:true});
  await expect(stepper).toHaveText('Off');
  await row.getByRole('button',{name:'Longer',exact:true}).click();
  await expect(stepper).toHaveText('5 min');
  await snap('sleep-timer');
  // The setting pop-up (#890) has no Done: its button again closes it.
  await controls.click(sleep,'Sleep timer');
  await expect(row).toHaveCount(0);
  await expect(sleep).toHaveAccessibleName('Sleep timer: 5 min left');
  // Off again, so nothing is left running; Escape closes it as a reader would.
  await controls.click(sleep,'Sleep timer');
  await row.getByRole('button',{name:'Shorter',exact:true}).click();
  await expect(stepper).toHaveText('Off');
  await page.keyboard.press('Escape');
  await expect(row).toHaveCount(0);
  await expect(sleep).toHaveAccessibleName('Sleep timer: off');
 });
 await step('Search, a bookmark and Back to narration',async()=>{
  const manifest=await getJSON(requestFrom(page.context()),`/api/reader/${encodeURIComponent(ebook.id)}`,null);
  const text=manifest.sections.flatMap(s=>s.paragraphs).find(f=>f.id===middle.paragraphId)?.text||'';
  const words=text.trim().split(/\s+/).slice(0,6).join(' ');
  if(words.length<2)throw Error(`The narrated sentence ${middle.paragraphId} has no words to search for`);
  await controls.click(shown(head.getByRole('button',{name:'Search this book',exact:true})),'Search this book');
  await expect(page.getByRole('heading',{level:1,name:'Search',exact:true})).toBeVisible();
  const field=page.getByRole('searchbox',{name:'Search this book',exact:true});
  await field.fill(words);
  await expect(page.locator('.reader-pages-count')).toHaveText(/^\d+ sentences?$/);
  await snap('search');
  await shown(page.locator('.reader-pages-result').filter({hasText:words})).first().click();
  await expect(full).toBeVisible();
  await expect(room).not.toHaveAttribute('data-current-passage',/.+/);
  // A bookmark on the sentence the result opened; the POST is answered by the guard.
  const toggle=head.locator('.reader-bookmark-toggle');
  await controls.click(shown(toggle),'Bookmark');
  await expect(toggle).toHaveAttribute('aria-pressed','true');
  await controls.click(shown(room.getByRole('button',{name:'Back to narration',exact:true})),'Back to narration');
  await onNarration();
  // A phone opens Bookmarks from the foot's Chapters; a desktop has the contents beside the text and no Chapters in its
  // foot, so the Bookmarks page is opened by its address there, over the reader, as the foot's button would.
  if(size.width<760){
   await controls.click(shown(foot.getByRole('button',{name:'Chapters',exact:true})),'Chapters');
   await page.getByRole('radio',{name:'Bookmarks',exact:true}).click();
  }else await page.evaluate(workId=>{location.hash=`#book/${encodeURIComponent(workId)}/bookmarks`;},book.workId);
  await expect(page.getByRole('heading',{level:1,name:'Bookmarks',exact:true})).toBeVisible();
  const list=page.getByRole('list',{name:'Bookmarks',exact:true});
  await expect(list.getByRole('listitem')).toHaveCount(1+(await existingBookmarks(manifest)));
  await snap('bookmarks');
  // Removed again (its DELETE is answered by the guard), so the device keeps no bookmark the server does not have.
  const remove=shown(list.getByRole('button',{name:/^Remove bookmark: /})).last();
  await remove.click();
  await expect(list.getByRole('listitem')).toHaveCount(await existingBookmarks(manifest));
  await shown(page.getByRole('button',{name:'Back to the book',exact:true})).first().click();
  await expect(full).toBeVisible();
  await onNarration();
 });
 await step('A long-press listens from the sentence and Undo returns',async()=>{
  await seek(middle.middle);
  await onNarration();
  const before=(await audio()).position;
  if(size.width<760)await controls.hide();
  let at=null,last=null;
  await expect.poll(async()=>{const point=await narratedPressPoint(room),stable=!!point&&!!last&&Math.abs(point.x-last.x)<0.5&&Math.abs(point.y-last.y)<0.5;last=point;if(stable)at=point;return stable;},{message:`the narrated sentence ${middle.paragraphId} has no stable line on the page to press`}).toBe(true);
  await page.mouse.move(at.x,at.y);await page.mouse.down();await page.waitForTimeout(800);await page.mouse.up();
  await expect(room.getByRole('status').filter({hasText:'Listening from here'})).toBeVisible();
  await expect.poll(async()=>!(await audio()).paused,{timeout:20000}).toBe(true);
  await snap('long-press');
  await shown(room.locator('.reader-message').getByRole('button',{name:'Undo',exact:true})).click();
  await expect.poll(async()=>Math.abs((await audio()).position-before),{timeout:20000}).toBeLessThan(3);
  // Nothing played before the press, so Undo stops the narration again (src/components/Reader.tsx); if it still
  // plays, the foot's own Pause stops it. Pausing the element from here raced the app's Undo.
  const paused=()=>expect.poll(async()=>(await audio()).paused,{timeout:5000}).toBe(true);
  await paused().catch(async()=>{await controls.click(shown(foot.getByRole('button',{name:'Pause narration',exact:true})),'Pause narration');await paused();});
 });
 await step('The face remembered across a reopen',async()=>{
  await controls.click(shown(head.getByRole('button',{name:'Close reader',exact:true})),'Close reader');
  await expect(full).toBeHidden();
  expect(await openFromDock()).toBe('#read');
  await expect.poll(hash).toBe(`#read/${book.workId}`);
  await expect(room.locator('.reader-viewport .prepared-text').first()).toBeVisible();
  await snap('read-reopened');
 });
 report.positionAfter=await audio().catch(()=>null);
}

// The suite's bookmarks of the edition before the check: the reader shows them beside the one the check adds.
const existingBookmarks=async(manifest)=>Array.isArray(manifest.bookmarks)?manifest.bookmarks.length:0;

// An ebook-only book on Read (#594): the foot holds the place and the slider, never the narration.
async function walkEbookOnly({page,work,snap}){
 await page.goto('about:blank');
 await page.goto(`/#book/${encodeURIComponent(work.workId)}`);
 const bookPage=page.getByRole('region',{name:'Book',exact:true});
 await expect(bookPage.getByRole('button',{name:'Listen',exact:true})).toBeDisabled();
 await shown(bookPage.getByRole('button',{name:'Read',exact:true})).click();
 await expect.poll(()=>page.evaluate(()=>decodeURIComponent(location.hash))).toBe(`#read/${work.workId}`);
 const room=page.locator('.now-playing-screen .reader-room'),foot=room.locator('.reader-player');
 await expect(room.locator('.reader-viewport .prepared-text').first()).toBeVisible();
 await createReaderControls({page,room}).show();
 const slider=foot.getByRole('slider',{name:'Position in the book',exact:true});
 await expect(shown(slider)).toBeVisible();
 await expect(foot.getByRole('button',{name:/^(Play|Pause) narration$|^Back to narration$|^Sleep timer/})).toHaveCount(0);
 await expect(room.locator('.sonder-follow')).toHaveCount(0);
 await snap('ebook-only');
 // The slider moves the page when let go; the reading place it saves is answered by the guard.
 const before=Number(await slider.inputValue());
 await expect(slider).toBeEnabled();
 const box=await slider.boundingBox();
 // Toward whichever end has room: the owner's place in the book may already be past the middle.
 const to=before>500?0.2:0.8;
 await page.mouse.click(box.x+box.width*to,box.y+box.height/2);
 await expect.poll(async()=>Math.abs(Number(await slider.inputValue())-before),{timeout:15000}).toBeGreaterThan(100);
 // Still nothing narrates it. (The sentence the slider lands on is marked as any jump's target is, showFragment in
 // src/components/Reader.tsx, with the same highlight as narration: so only the foot is checked here.)
 await expect(foot.getByRole('button',{name:/^(Play|Pause) narration$/})).toHaveCount(0);
 await snap('ebook-only-slider');
}

async function main(){
 // A local test server (tests/browser-server.ts) has no .env and no password; production reads both from .env.
 if(fs.existsSync('.env'))process.loadEnvFile('.env');
 const {preferred,allowRecent}=verifyChoice();
 const baseURL=verifyBaseURL();
 const {chromium}=await import('@playwright/test');
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'});
 const report={};
 try{
  await runSlicePass({browser,baseURL,preferred,allowRecent,preferredEbookWork:process.env.SONDER_VERIFY_EBOOK_WORK||null,password:process.env.APP_PASSWORD||null,report});
  if(!report.ok)process.exitCode=1;
 }catch(error){
  if(error instanceof NoSuitableRecording){report.ok=null;report.skipped=error.reason;process.exitCode=NO_SUITABLE_RECORDING_EXIT;console.log(error.message);if(process.env.SONDER_LIVE_CHECK_SKIP_FILE)fs.writeFileSync(process.env.SONDER_LIVE_CHECK_SKIP_FILE,error.reason);}
  else{report.ok=false;report.failure=error.message;process.exitCode=1;}
 }finally{
  report.errors??=[];
  await closeProtectedBrowser({close:async()=>{}},browser,report);
  fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/slice-pass-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
