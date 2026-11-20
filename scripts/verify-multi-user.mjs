// Exercise multi-user isolation on the deployed app with a temporary QA user.
// The QA user is created and always removed again; the admin's own data is
// only read, never written, and is compared before and after.
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
import {FORBIDDEN} from './multi-user-forbidden.mjs';
import {verifyBaseURL} from './live-check-target.mjs';
import {adminMultiUserVerifySnapshot,assertAdminMultiUserVerifyUnchanged} from './verify-multi-user-snapshot.mjs';
import {assertNoLeakedPlaceholders} from './multi-user-placeholders.mjs';
import {multiUserPlayable} from './live-check-recording.mjs';
const expect=baseExpect.configure({timeout:25000});
// Production reads APP_PASSWORD from .env. A local test server needs one too: the check signs in as the administrator
// and makes a second account (tests/browser-server.ts with PLAYWRIGHT_AUTH=1 and APP_PASSWORD in the environment).
if(fs.existsSync('.env'))process.loadEnvFile('.env');
if(!process.env.APP_PASSWORD)throw Error('The multi-user check needs APP_PASSWORD, the administrator\'s password (from .env or the environment)');
const baseURL=verifyBaseURL();
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'});
const report={checks:[],errors:[]};
const check=(name,details={})=>report.checks.push({name,...details});
const admin=await browser.newContext({baseURL,serviceWorkers:'block'});
let qaId=null;
try {
 // Older-client login shape: password only is the admin.
 const login=await admin.request.post('/api/auth/login',{data:{password:process.env.APP_PASSWORD}});if(!login.ok())throw Error('Admin sign-in failed');
 const status=await(await admin.request.get('/api/auth/status')).json();
 expect(status.user).toMatchObject({id:1,role:'admin'});
 check('Password-only sign-in is the admin');
 const adminBooks=async()=>(await(await admin.request.get('/api/books')).json()).map(b=>({id:b.id,inLibrary:b.inLibrary,status:b.status,progress:b.progress&&{position:b.progress.position,updatedAt:b.progress.updatedAt}}));
 const adminCatalogue=(await(await admin.request.get('/api/books')).json());
 const beforeBooks=await adminBooks();
 const adminAppearance=await(await admin.request.get('/api/appearance')).json();
 const adminHardcover=(await(await admin.request.get('/api/settings')).json()).hardcoverConfigured;
 const username=`qa-${Date.now().toString(36)}`,password=randomBytes(12).toString('base64url');
 const created=await admin.request.post('/api/users',{data:{username,password}});if(!created.ok())throw Error('Could not create QA user: '+await created.text());
 qaId=(await(await admin.request.get('/api/users')).json()).find(u=>u.username===username).id;
 check('Admin created a temporary user',{username});
 const qa=await browser.newContext({baseURL,viewport:{width:390,height:844},serviceWorkers:'block'});
 const page=await qa.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto('/');
 await page.getByLabel('Username').fill(username);await page.getByLabel('Password',{exact:true}).fill(password);
 await page.getByRole('button',{name:/^Sign in/}).click();
 await expect(page.getByRole('navigation').first()).toBeVisible();
 const qaStatus=await(await qa.request.get('/api/auth/status')).json();
 expect(qaStatus.user).toMatchObject({username,role:'user'});
 check('User signs in through the real sign-in screen');
 const qaBooks=await(await qa.request.get('/api/books')).json();
 // Every title with audio is shared; the administrator's placeholders are not (r6#1). A placeholder is an audio
 // edition whose recordings have no track (#483), whatever its id: an ebook-only book's (#555) too.
 const withAudio=adminCatalogue.filter(b=>b.tracks?.length).map(b=>b.id).sort();
 expect(qaBooks.filter(b=>b.tracks?.length).map(b=>b.id).sort()).toEqual(withAudio);
 assertNoLeakedPlaceholders(qaBooks);
 expect(qaBooks.filter(b=>b.inLibrary).length).toBe(0);
 expect(qaBooks.filter(b=>b.progress).length).toBe(0);
 check('User sees every title with audio, none of the admin\'s placeholders, an empty library and no progress',{userCatalogue:qaBooks.length,adminCatalogue:adminCatalogue.length,withAudio:withAudio.length,adminPlaceholders:adminCatalogue.length-withAudio.length});
 const forbidden=FORBIDDEN;
 for(const [method,url,data] of forbidden){const r=await qa.request.fetch(url,{method,data});if(r.status()!==403)throw Error(`${method} ${url} returned ${r.status()} for a regular user`);}
 const settings=await(await qa.request.get('/api/settings')).json();
 if(JSON.stringify(settings).match(/torbox|prowlarr|transmission/i))throw Error('Regular-user settings expose admin fields: '+Object.keys(settings).join(','));
 check('Admin-only routes refuse the user; settings hide admin fields',{routes:forbidden.length});
 // Not a book the administrator listened to in the last 48 h, while there is another (#774).
 const {book:playable,recent:playableRecent}=multiUserPlayable(qaBooks,adminCatalogue);
 if(!playable)throw Error('The user sees no title with audio');
 const media=await qa.request.get(`/api/media/${encodeURIComponent(playable.tracks[0].id)}/location?source=auto`);
 if(!media.ok())throw Error('User cannot resolve media: '+media.status());
 check('User can resolve shared media',{book:playable.title,...(playableRecent?{recent:playableRecent}:{})});
 // Settings is a list whose rows open pages (#579, src/settings-list.ts): someone who is not the administrator
 // sees Personal (Account, Appearance, Playback) and This device (App); Connections (the administrator's since
 // Hardcover went, #721 part d), Users and Library and storage are in the Server group only the administrator has.
 // A row is a button named by its label and its value ("Account qa-… · User").
 await page.goto('/#settings');
 const list=page.getByRole('navigation',{name:'Settings',exact:true});
 await expect(list.getByRole('heading',{name:'Personal',exact:true})).toBeVisible();
 await expect(list.getByRole('heading',{name:'This device',exact:true})).toBeVisible();
 await expect(list.getByRole('heading',{name:'Server',exact:true})).toHaveCount(0);
 const rows=['Account','Appearance','Playback','App'];
 for(const label of rows)await expect(list.getByRole('button',{name:new RegExp(`^${label}(\\s|$)`)})).toBeVisible();
 await expect(list.getByRole('button')).toHaveCount(rows.length);
 for(const hidden of ['Connections','Users','Library and storage','TorBox','Prowlarr'])await expect(list.getByRole('button',{name:new RegExp(`^${hidden}`)})).toHaveCount(0);
 await page.screenshot({path:'artifacts/live-multi-user-settings.png',fullPage:true});
 await list.getByRole('button',{name:/^Account\s/}).click();
 await expect(page.getByRole('heading',{name:'Account',level:1})).toBeVisible();
 // The administrator's pages are refused at their address: it opens the Settings list.
 for(const admin of ['connections','users','library']){await page.goto(`/#settings/${admin}`);await expect(page.getByRole('heading',{name:'Settings',level:1})).toBeVisible();await expect(page.getByRole('heading',{name:/^(Connections|Users|Library and storage)$/,level:1})).toHaveCount(0);}
 check('Settings lists Account, Appearance, Playback and App, and refuses the administrator\'s pages',{rows});
 // Write as the QA user only, then confirm the admin did not change.
 const track=playable.tracks[0];
 const wrote=await qa.request.post('/api/progress',{data:{recordingId:playable.recordingId,trackId:track.id,position:5,duration:track.duration||60,updatedAt:Date.now()},headers:{'x-sonder-user-id':String(qaId)}});
 if(!wrote.ok())throw Error('User progress write failed: '+wrote.status());
 const added=await qa.request.post('/api/library',{data:{bookId:playable.id}});if(!added.ok())throw Error('User library add failed');
 const mismatch=await qa.request.post('/api/progress',{data:{recordingId:playable.recordingId,trackId:track.id,position:9,duration:track.duration||60,updatedAt:Date.now()},headers:{'x-sonder-user-id':'1'}});
 if(mismatch.status()!==409)throw Error('A write tagged for another user was not refused: '+mismatch.status());
 const beforeSnap=adminMultiUserVerifySnapshot(beforeBooks,playable.id);
 const afterBooks=await adminBooks();
 assertAdminMultiUserVerifyUnchanged(beforeSnap,adminMultiUserVerifySnapshot(afterBooks,playable.id));
 if(JSON.stringify(await(await admin.request.get('/api/appearance')).json())!==JSON.stringify(adminAppearance))throw Error('Admin appearance changed');
 if((await(await admin.request.get('/api/settings')).json()).hardcoverConfigured!==adminHardcover)throw Error('Admin Hardcover state changed');
 check('User writes stay with the user; mismatched user id is refused; admin data unchanged');
 await qa.close();
 expect(report.errors).toEqual([]);report.ok=true;
} catch(error){report.ok=false;report.failure=error.message;process.exitCode=1;}
finally{
 if(qaId){const r=await admin.request.delete(`/api/users/${qaId}`);report.cleanup=r.ok()?'QA user removed':'QA user removal failed: '+r.status();}
 await browser.close();fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/multi-user-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
