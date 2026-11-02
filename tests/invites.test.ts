import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp=mkdtempSync(join(tmpdir(),"sonder-invites-"));
process.env.DATA_DIR=join(temp,"db"); process.env.MEDIA_ROOT=join(temp,"media"); process.env.REQUIRE_MEDIA_MOUNT="false"; process.env.NODE_ENV="test"; process.env.APP_PASSWORD="admin-password";
const { createApp }=await import("../server/app.ts");
const { sqlite }=await import("../server/db.ts");
const { hashToken }=await import("../server/security.ts");
const app=await createApp();
after(async()=>{ await app.close(); sqlite.close(); rmSync(temp,{recursive:true,force:true}); });
// Every client comes from its own address so per-IP rate limits cannot trip a
// test that is not about the limit itself.
let ip=0;
const freshIp=()=>`203.0.113.${++ip}`;
const admin=(await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":freshIp()},payload:{password:"admin-password"}})).cookies[0].value;
const asAdmin=(url:string,payload:Record<string,unknown>={})=>app.inject({method:"POST",url,cookies:{sonder_session:admin},payload});
// Submit a request for `username` and have the administrator approve it with no
// email configured, then hand back the raw invite token from the returned link.
const inviteToken=async(username:string)=>{
  const submitted=await app.inject({method:"POST",url:"/api/account-requests",headers:{"x-forwarded-for":freshIp()},payload:{email:`${username}@example.com`,username}});
  assert.equal(submitted.statusCode,200,submitted.body);
  const id=(sqlite.prepare("SELECT id FROM account_requests WHERE username=?").get(username) as {id:number}).id;
  const approved=await asAdmin(`/api/account-requests/${id}/approve`);
  assert.equal(approved.statusCode,200,approved.body);
  return new URL(approved.json().inviteLink as string).searchParams.get("token") as string;
};
const markExpired=(token:string)=>{
  const invite=(sqlite.prepare("SELECT id FROM account_invites WHERE token=?").get(hashToken(token)) as {id:number}).id;
  sqlite.prepare("UPDATE account_invites SET expires_at=? WHERE id=?").run(Date.now()-1000,invite);
};
const verify=(token:string)=>app.inject({method:"GET",url:`/api/invites/verify?token=${encodeURIComponent(token)}`});
test("verify reports the applicant's username and email for a valid unclaimed invite", async () => {
  const token=await inviteToken("verifyreader");
  const res=await verify(token);
  assert.equal(res.statusCode,200,res.body);
  assert.deepEqual(res.json(),{ok:true,username:"verifyreader",email:"verifyreader@example.com"});
});
test("verify without a token is a bad request", async () => {
  const res=await app.inject({method:"GET",url:"/api/invites/verify"});
  assert.equal(res.statusCode,400,res.body);
});
test("verify refuses a token that was never issued", async () => {
  const res=await verify(randomBytes(32).toString("hex"));
  assert.equal(res.statusCode,404,res.body);
  assert.equal(res.json().error,"This invite link is not valid.");
});
test("verify refuses an already claimed invite with a distinct message", async () => {
  const token=await inviteToken("takenlink");
  const invite=(sqlite.prepare("SELECT id FROM account_invites WHERE token=?").get(hashToken(token)) as {id:number}).id;
  sqlite.prepare("UPDATE account_invites SET claimed_at=? WHERE id=?").run(Date.now(),invite);
  const res=await verify(token);
  assert.equal(res.statusCode,404,res.body);
  assert.equal(res.json().error,"This invite link has already been used.");
});
test("verify refuses an expired invite with 410", async () => {
  const token=await inviteToken("expiredlink");
  markExpired(token);
  const res=await verify(token);
  assert.equal(res.statusCode,410,res.body);
  assert.equal(res.json().error,"This invite link has expired.");
});
const claim=(payload:{token:string;password:string},ipAddr?:string)=>app.inject({method:"POST",url:"/api/invites/claim",headers:{"x-forwarded-for":ipAddr||freshIp()},payload});
test("claim creates the user, marks the invite claimed and signs the applicant in", async () => {
  const token=await inviteToken("newuser");
  const before=(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as {n:number}).n;
  const res=await claim({token,password:"reader-password-1"});
  assert.equal(res.statusCode,200,res.body);
  const body=res.json();
  assert.equal(body.ok,true);
  assert.equal(body.user.username,"newuser");
  assert.equal(body.user.role,"user");
  assert.equal(typeof body.user.id,"number");
  assert.ok(body.user.id>1);
  const user=sqlite.prepare("SELECT username,role,password_hash,created_at FROM users WHERE id=?").get(body.user.id) as any;
  assert.equal(user.username,"newuser");
  assert.equal(user.role,"user");
  assert.ok(user.created_at>0);
  assert.ok(user.password_hash?.startsWith("scrypt$"),user.password_hash);
  const invite=(sqlite.prepare("SELECT claimed_at FROM account_invites WHERE token=?").get(hashToken(token)) as {claimed_at:number|null}).claimed_at;
  assert.ok(invite!==null&&invite>0);
  // The raw token was never stored; only its hash is.
  const stored=(sqlite.prepare("SELECT token FROM account_invites").all() as {token:string}[]).map(r=>r.token);
  assert.ok(!stored.includes(token));
  assert.ok(stored.includes(hashToken(token)));
  // The session cookie mirrors POST /api/auth/login: http-only, 30 days, hashed row.
  const cookie=res.cookies[0] as {name:string;value:string;maxAge:number;path:string;httpOnly:boolean;sameSite:string};
  assert.equal(cookie.name,"sonder_session");
  assert.match(cookie.value,/^[0-9a-f]{64}$/);
  assert.equal(cookie.maxAge,30*86400);
  assert.equal(cookie.path,"/");
  assert.equal(cookie.httpOnly,true);
  assert.equal(cookie.sameSite,"Strict");
  const session=sqlite.prepare("SELECT user_id,expires_at FROM sessions WHERE token=?").get(hashToken(cookie.value)) as {user_id:number;expires_at:number}|undefined;
  assert.ok(session);
  assert.equal(session!.user_id,body.user.id);
  assert.ok(session!.expires_at>Date.now()+29*86400000&&session!.expires_at<Date.now()+31*86400000);
  // The cookie signs the applicant in.
  const status=await app.inject({method:"GET",url:"/api/auth/status",cookies:{sonder_session:cookie.value}});
  assert.equal(status.statusCode,200,status.body);
  assert.equal(status.json().authenticated,true);
  assert.equal(status.json().user.username,"newuser");
  const usersAfter=(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as {n:number}).n;
  assert.equal(usersAfter,before+1);
});
test("claim refuses a weak password and creates nothing", async () => {
  const token=await inviteToken("weakpass");
  const before=(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as {n:number}).n;
  const res=await claim({token,password:"short"});
  assert.equal(res.statusCode,400,res.body);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as {n:number}).n,before);
  const invite=(sqlite.prepare("SELECT claimed_at FROM account_invites WHERE token=?").get(hashToken(token)) as {claimed_at:number|null}).claimed_at;
  assert.equal(invite,null);
  // The weak password is not remembered: a strong retry claims the same invite.
  const retry=await claim({token,password:"strong-enough-1"});
  assert.equal(retry.statusCode,200,retry.body);
  assert.equal(retry.json().user.username,"weakpass");
});
test("a second claim with the same token fails clearly", async () => {
  const token=await inviteToken("reuser");
  const first=await claim({token,password:"first-password-1"});
  assert.equal(first.statusCode,200,first.body);
  const second=await claim({token,password:"second-password-1"});
  assert.equal(second.statusCode,404,second.body);
  assert.equal(second.json().error,"This invite link has already been used.");
  const accounts=sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE username='reuser'").get() as {n:number};
  assert.equal(accounts.n,1);
});
test("claim refuses a token that was never issued", async () => {
  const res=await claim({token:randomBytes(32).toString("hex"),password:"unknown-password-1"});
  assert.equal(res.statusCode,404,res.body);
  assert.equal(res.json().error,"This invite link is not valid.");
});
test("claim refuses an expired invite", async () => {
  const token=await inviteToken("expiredclaim");
  markExpired(token);
  const res=await claim({token,password:"expired-password-1"});
  assert.equal(res.statusCode,410,res.body);
  assert.equal(res.json().error,"This invite link has expired.");
});
test("claim with a taken username fails clearly and leaves the invite unclaimed", async () => {
  const created=await asAdmin("/api/users",{username:"takenname",password:"admin-made-1"});
  assert.equal(created.statusCode,200,created.body);
  const before=(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as {n:number}).n;
  const token=await inviteToken("takenname");
  const res=await claim({token,password:"invite-password-1"});
  assert.equal(res.statusCode,409,res.body);
  assert.equal(res.json().error,"That username is already taken.");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as {n:number}).n,before);
  const invite=(sqlite.prepare("SELECT claimed_at FROM account_invites WHERE token=?").get(hashToken(token)) as {claimed_at:number|null}).claimed_at;
  assert.equal(invite,null);
});
test("a client is limited to ten claims per fifteen minutes", async () => {
  const from=(token:string)=>app.inject({method:"POST",url:"/api/invites/claim",headers:{"x-forwarded-for":"203.0.113.200"},payload:{token,password:"rate-limited-1"}});
  for(let i=0;i<10;i++) assert.equal((await from(randomBytes(32).toString("hex"))).statusCode,404);
  const blocked=await from(randomBytes(32).toString("hex"));
  assert.equal(blocked.statusCode,429,blocked.body);
});
