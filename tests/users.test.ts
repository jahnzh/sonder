import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Plain JS module shared with the live verify script.
import { FORBIDDEN } from "../scripts/multi-user-forbidden.mjs";
const temp=mkdtempSync(join(tmpdir(),"sonder-users-"));
process.env.DATA_DIR=join(temp,"db"); process.env.MEDIA_ROOT=join(temp,"media"); process.env.REQUIRE_MEDIA_MOUNT="false"; process.env.NODE_ENV="test"; process.env.APP_PASSWORD="admin-password";
const { createApp }=await import("../server/app.ts");
const { sqlite }=await import("../server/db.ts");
const app=await createApp();
after(async()=>{ await app.close(); sqlite.close(); rmSync(temp,{recursive:true,force:true}); });
test("users have isolated libraries and progress and cannot access administration",async()=>{
 const login=async(username:string|undefined,password:string)=>{const r=await app.inject({method:"POST",url:"/api/auth/login",payload:{username,password}}); assert.equal(r.statusCode,200,r.body); return r.cookies[0].value;};
 const admin=await login(undefined,"admin-password");
 for(const username of ["first","second"]){ const r=await app.inject({method:"POST",url:"/api/users",cookies:{sonder_session:admin},payload:{username,password:"password1"}}); assert.equal(r.statusCode,200,r.body); }
 const first=await login("first","password1"), second=await login("second","password1");
 const request=(cookie:string,method:any,url:string,payload?:any)=>app.inject({method,url,cookies:{sonder_session:cookie},payload});
 const books=(await request(first,"GET","/api/books")).json(); const book=books[0];
 assert.equal((await request(first,"POST","/api/library",{bookId:book.id})).statusCode,200);
 assert.equal((await request(first,"PATCH",`/api/library/${book.id}`,{status:"finished"})).statusCode,200);
 const position={recordingId:book.recordingId,trackId:book.tracks[0].id,position:12,duration:100,updatedAt:Date.now()};
 assert.equal((await request(first,"POST","/api/progress",position)).statusCode,200);
 const appearance=(await request(first,"GET","/api/appearance")).json();
 const changed={...appearance, preset: appearance.preset === "light" ? "forest" : "light"};
 assert.equal((await request(first,"PUT","/api/appearance",changed)).statusCode,200);
 assert.notDeepEqual((await request(first,"GET","/api/appearance")).json(),(await request(second,"GET","/api/appearance")).json());
 const a=(await request(first,"GET","/api/books")).json().find((x:any)=>x.id===book.id); const b=(await request(second,"GET","/api/books")).json().find((x:any)=>x.id===book.id);
 assert.equal(a.status,"finished"); assert.equal(a.progress.position,12); assert.equal(b.inLibrary,false); assert.equal(b.progress,undefined);
 for(const [method,url,payload] of [["PATCH","/api/settings",{torbox:"x"}],["POST","/api/acquire",{}],["POST","/api/import",{}],["POST","/api/alignments",{}]] as const) assert.equal((await request(first,method,url,payload)).statusCode,403,url);
 // An empty save from the reduced Settings form is a harmless no-op (r6#5).
 assert.equal((await request(first,"PATCH","/api/settings",{})).statusCode,200);
 const { readerFixture }=await import("./reader-fixture.ts");
 const ebookDir=join(temp,"media","ebooks"); mkdirSync(ebookDir,{recursive:true}); const epub=join(ebookDir,"isolation.epub"); writeFileSync(epub,await readerFixture());
 sqlite.prepare("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,?,?)").run("isolation",book.workId,"epub",epub);
 const locator={section:0,paragraphId:"0:0",progression:0.1};
 const checkpoint={locator,baseRevision:0,eventId:"event-first",deviceId:"device-first",updatedAt:Date.now()};
 assert.equal((await request(first,"PUT","/api/reader/isolation/progress",checkpoint)).statusCode,200);
 assert.equal((await request(second,"PUT","/api/reader/isolation/progress",checkpoint)).statusCode,200);
 assert.equal((await request(first,"POST","/api/reader/isolation/bookmarks",{id:"bookmark-first",label:"First",locator})).statusCode,200);
 const firstReader=(await request(first,"GET","/api/reader/isolation")).json(), secondReader=(await request(second,"GET","/api/reader/isolation")).json();
 assert.equal(firstReader.checkpoint.revision,1); assert.equal(secondReader.checkpoint.revision,1); assert.equal(firstReader.bookmarks.length,1); assert.equal(secondReader.bookmarks.length,0);
 // The day a bookmark was saved (#590) is the saver's: it comes with that user's bookmark and reaches no one else.
 assert.equal(typeof firstReader.bookmarks[0].createdAt,"number"); assert.ok(Math.abs(firstReader.bookmarks[0].createdAt-Date.now())<60_000);
 assert.doesNotMatch(JSON.stringify(secondReader),/bookmark-first|createdAt/);
 assert.equal((await request(first,"DELETE",`/api/library/${book.id}`)).statusCode,200);
 assert.ok(sqlite.prepare("SELECT 1 FROM user_hidden_library WHERE user_id=2 AND book_id=?").get(book.id)); assert.equal(sqlite.prepare("SELECT 1 FROM user_hidden_library WHERE user_id=3 AND book_id=?").get(book.id),undefined);
 assert.equal((await request(admin,"GET","/api/auth/status")).json().user.username,"admin");
 // A write queued under the first user and replayed under the second user's session is refused before it lands.
 const firstId=(await request(first,"GET","/api/auth/status")).json().user.id;
 const replay=await app.inject({method:"POST",url:"/api/progress",cookies:{sonder_session:second},headers:{"x-sonder-user-id":String(firstId)},payload:{...position,position:77,updatedAt:Date.now()}});
 assert.equal(replay.statusCode,409); assert.equal(replay.json().code,"user_mismatch");
 assert.equal((await request(second,"GET","/api/books")).json().find((x:any)=>x.id===book.id).progress,undefined);
 const matching=await app.inject({method:"POST",url:"/api/progress",cookies:{sonder_session:first},headers:{"x-sonder-user-id":String(firstId)},payload:{...position,position:78,updatedAt:Date.now()}});
 assert.equal(matching.statusCode,200,matching.body);
});

test("verify-multi-user forbidden routes return 403 for a regular user", async () => {
 const admin=(await app.inject({method:"POST",url:"/api/auth/login",payload:{password:"admin-password"}})).cookies[0].value;
 await app.inject({method:"POST",url:"/api/users",cookies:{sonder_session:admin},payload:{username:"forbidden",password:"password1"}});
 const user=(await app.inject({method:"POST",url:"/api/auth/login",payload:{username:"forbidden",password:"password1"}})).cookies[0].value;
 assert.ok(FORBIDDEN.length > 0);
 for (const [method, url, data] of FORBIDDEN) {
  const r=await app.inject({method,url,cookies:{sonder_session:user},payload:data});
  assert.equal(r.statusCode,403,`${method} ${url}: ${r.body}`);
 }
});

test("migration copies legacy rows once without changing them", async () => {
 const { execFileSync }=await import("node:child_process");
 const { default: Database }=await import("better-sqlite3");
 const migrationDir=join(temp,"migration");
 const env={...process.env,DATA_DIR:migrationDir};
 const run=()=>execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",'import "./server/db.ts"'],{cwd:process.cwd(),env});
 run();
 const legacy=new Database(join(migrationDir,"sonder.db"));
 legacy.exec("DELETE FROM settings WHERE key='migration:multi-user'; INSERT INTO works VALUES('w','Title','Author','','',2000); INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('b','w','','',0,''); INSERT INTO library VALUES('b','finished',123); INSERT INTO settings VALUES('appearance','original')");
 legacy.close(); run();
 const migrated=new Database(join(migrationDir,"sonder.db"));
 assert.deepEqual(migrated.prepare("SELECT book_id,status,added_at FROM library").all(),[{book_id:"b",status:"finished",added_at:123}]);
 assert.deepEqual(migrated.prepare("SELECT user_id,book_id,status,added_at FROM user_library").all(),[{user_id:1,book_id:"b",status:"finished",added_at:123}]);
 assert.equal((migrated.prepare("SELECT value FROM user_settings WHERE user_id=1 AND key='appearance'").get() as any).value,"original");
 migrated.prepare("UPDATE user_library SET status='listening'").run(); migrated.close(); run();
 const reopened=new Database(join(migrationDir,"sonder.db")); assert.equal((reopened.prepare("SELECT status FROM user_library").get() as any).status,"listening"); assert.equal((reopened.prepare("SELECT status FROM library").get() as any).status,"finished"); reopened.close();
});

test("encoded admin routes are denied to regular users", async () => {
 const admin=(await app.inject({method:"POST",url:"/api/auth/login",payload:{password:"admin-password"}})).cookies[0].value;
 await app.inject({method:"POST",url:"/api/users",cookies:{sonder_session:admin},payload:{username:"encoded",password:"password1"}});
 const user=(await app.inject({method:"POST",url:"/api/auth/login",payload:{username:"encoded",password:"password1"}})).cookies[0].value;
 for (const [method,url] of [["GET","/api/%61cquisitions"],["GET","/api/%74orbox/files"],["POST","/api/%61cquire"],["POST","/api/books/x/%6beep"],["DELETE","/api/recordings/x/server%2Dcopy"],["PUT","/api/recordings/x/f%61ults/source"],["POST","/api/reader/x/%6cink"],["POST","/api/%61lignments"],["GET","/api/discover/%61bb"],["GET","/api/discover/%70rowlarr/releases"],["GET","/api/discover/%65books"],["POST","/api/%65books/import"],["POST","/api/ebooks/import"]] as const) {
  const r=await app.inject({method,url,cookies:{sonder_session:user},payload:method === "GET" ? undefined : {}}); assert.equal(r.statusCode,403,`${url}: ${r.body}`);
 }
});

test("password changes revoke other sessions, admin resets revoke all, IDs never repeat and admin role is rejected", async () => {
 const login=async(username:string|undefined,password:string)=> (await app.inject({method:"POST",url:"/api/auth/login",payload:{username,password},headers:{"x-forwarded-for":"192.0.2.10"}})).cookies[0]?.value;
 const admin=await login(undefined,"admin-password");
 const req=(method:any,url:string,payload?:any,cookie=admin)=>app.inject({method,url,payload,cookies:{sonder_session:cookie}});
 assert.equal((await req("POST","/api/users",{username:"badadmin",password:"password1",role:"admin"})).statusCode,400);
 const created=(await req("POST","/api/users",{username:"sessiontest",password:"password1"})).json();
 assert.equal((await req("PATCH",`/api/users/${created.id}`,{role:"admin"})).statusCode,400);
 const one=await login("sessiontest","password1"), two=await login("sessiontest","password1");
 assert.equal((await req("POST","/api/auth/password",{currentPassword:"password1",newPassword:"password2"},one)).statusCode,200);
 assert.equal((await req("GET","/api/books",undefined,one)).statusCode,200); assert.equal((await req("GET","/api/books",undefined,two)).statusCode,401);
 assert.equal((await req("PATCH",`/api/users/${created.id}`,{password:"password3"})).statusCode,200); assert.equal((await req("GET","/api/books",undefined,one)).statusCode,401);
 const {onUserDeleted}=await import("../server/users.ts"); let deleted=0; const off=onUserDeleted(id=>{deleted=id});
 await req("DELETE",`/api/users/${created.id}`); off(); assert.equal(deleted,created.id);
 const next=(await req("POST","/api/users",{username:"nextuser",password:"password1"})).json(); assert.ok(next.id>created.id);
});

test("login rate limiting ignores arbitrary cookies and separates forwarded client IPs", async () => {
 for(let i=0;i<11;i++) { const r=await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":"192.0.2.50"},cookies:{sonder_session:`invalid${i}`},payload:{password:"bad"}}); assert.equal(r.statusCode,i<10?401:429); }
 // A sign-in made on the server itself (no proxy, a loopback address) is not counted: the coordinator's and the live checks' scripts.
 for(let i=0;i<12;i++) { const r=await app.inject({method:"POST",url:"/api/auth/login",remoteAddress:"127.0.0.1",cookies:{sonder_session:`local${i}`},payload:{password:"bad"}}); assert.equal(r.statusCode,401); }
 const other=await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":"192.0.2.51"},payload:{password:"bad"}}); assert.equal(other.statusCode,401);
});

test("regular progress never sets a shared duration, even an unknown one", async () => {
 const login=await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":"192.0.2.70"},payload:{username:"first",password:"password1"}});
 const cookie=login.cookies[0].value; const book=(await app.inject({url:"/api/books",cookies:{sonder_session:cookie}})).json()[0]; const id=book.tracks[0].id;
 sqlite.prepare("UPDATE tracks SET duration=100 WHERE id=?").run(id);
 const save=async(duration:number)=>app.inject({method:"POST",url:"/api/progress",cookies:{sonder_session:cookie},payload:{recordingId:book.recordingId,trackId:id,position:1,duration,updatedAt:Date.now()}});
 await save(200); assert.equal((sqlite.prepare("SELECT duration FROM tracks WHERE id=?").get(id) as any).duration,100);
 sqlite.prepare("UPDATE tracks SET duration=0 WHERE id=?").run(id); await save(1); assert.equal((sqlite.prepare("SELECT duration FROM tracks WHERE id=?").get(id) as any).duration,0);
 const admin=(await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":"192.0.2.71"},payload:{password:"admin-password"}})).cookies[0].value;
 await app.inject({method:"POST",url:"/api/progress",cookies:{sonder_session:admin},payload:{recordingId:book.recordingId,trackId:id,position:1,duration:200,updatedAt:Date.now()}});
 assert.equal((sqlite.prepare("SELECT duration FROM tracks WHERE id=?").get(id) as any).duration,200);
});

test("on first upgrade the next user id starts above every id left in sessions and per-user tables", async () => {
 const admin=(await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":"192.0.2.80"},payload:{password:"admin-password"}})).cookies[0].value;
 const create=async(username:string)=>(await app.inject({method:"POST",url:"/api/users",cookies:{sonder_session:admin},payload:{username,password:"password1"}})).json().id as number;
 // Accounts deleted before the mark existed left rows behind, and no mark is stored yet.
 const upgrade=(trace:()=>void)=>{ sqlite.pragma("foreign_keys = OFF"); trace(); sqlite.pragma("foreign_keys = ON"); sqlite.prepare("DELETE FROM settings WHERE key='user_id_high_water'").run(); };
 const max=(sqlite.prepare("SELECT MAX(id) AS id FROM users").get() as {id:number}).id;
 upgrade(()=>sqlite.prepare("INSERT INTO user_settings(user_id,key,value) VALUES(?,?,?)").run(max+5,"appearance","{}"));
 const first=await create("afterupgrade1"); assert.equal(first,max+6);
 upgrade(()=>sqlite.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)").run("stale-session",first+3,0));
 assert.equal(await create("afterupgrade2"),first+4);
});
