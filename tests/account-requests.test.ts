import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp=mkdtempSync(join(tmpdir(),"sonder-account-requests-"));
process.env.DATA_DIR=join(temp,"db"); process.env.MEDIA_ROOT=join(temp,"media"); process.env.REQUIRE_MEDIA_MOUNT="false"; process.env.NODE_ENV="test"; process.env.APP_PASSWORD="admin-password";
const { createApp }=await import("../server/app.ts");
const { sqlite }=await import("../server/db.ts");
const app=await createApp();
after(async()=>{ await app.close(); sqlite.close(); rmSync(temp,{recursive:true,force:true}); });
// Every submission comes from its own client address so the per-IP request
// limit cannot trip a test that is not about the limit itself.
let ip=0;
const submit=(payload:any)=>app.inject({method:"POST",url:"/api/account-requests",headers:{"x-forwarded-for":`203.0.113.${++ip}`},payload});
test("an unauthenticated prospect can submit an account request", async () => {
  const res=await submit({email:"reader@example.com",username:"newreader",note:"Heard about you from a friend"});
  assert.equal(res.statusCode,200,res.body);
  assert.deepEqual(res.json(),{ok:true});
  const rows=sqlite.prepare("SELECT * FROM account_requests").all() as any[];
  assert.equal(rows.length,1);
  assert.equal(rows[0].email,"reader@example.com");
  assert.equal(rows[0].username,"newreader");
  assert.equal(rows[0].note,"Heard about you from a friend");
  assert.equal(rows[0].status,"pending");
  assert.ok(rows[0].created_at>0);
  assert.equal(rows[0].reviewed_at,null);
  assert.equal(rows[0].invite_id,null);
});
test("account request submissions with invalid email or username are refused and stored nothing", async () => {
  const before=sqlite.prepare("SELECT COUNT(*) AS n FROM account_requests").get() as {n:number};
  const invalid=[
    {email:"not-an-email",username:"readerone"},
    {email:"",username:"readerone"},
    {email:"reader@example.com",username:"a"},
    {email:"reader@example.com",username:"a".repeat(41)},
    {email:"reader@example.com",username:"bad name!"},
    {email:"reader@example.com",username:"café"},
    {email:"reader@example.com",username:"admin"},
    {email:"reader@example.com",username:"Admin"},
    {email:"reader@example.com",username:"ADMIN"},
  ];
  for(const payload of invalid) {
    const res=await submit(payload);
    assert.equal(res.statusCode,400,`${JSON.stringify(payload)}: ${res.body}`);
  }
  const after=sqlite.prepare("SELECT COUNT(*) AS n FROM account_requests").get() as {n:number};
  assert.equal(after.n,before.n);
  const two=await submit({email:"reader@example.com",username:"ab"});
  const forty=await submit({email:"reader@example.com",username:"b".repeat(40)});
  const styled=await submit({email:"reader@example.com",username:"Mixed.User-1_2"});
  for(const res of [two,forty,styled]) assert.equal(res.statusCode,200,res.body);
});
test("an automated submission filling the hidden honeypot is refused and stored nothing", async () => {
  const before=sqlite.prepare("SELECT COUNT(*) AS n FROM account_requests").get() as {n:number};
  const res=await submit({email:"bot@example.com",username:"botuser",honeypot:"http://spam.example"});
  assert.equal(res.statusCode,400,res.body);
  const after=sqlite.prepare("SELECT COUNT(*) AS n FROM account_requests").get() as {n:number};
  assert.equal(after.n,before.n);
  const human=await submit({email:"reader@example.com",username:"honeypot-free",honeypot:""});
  assert.equal(human.statusCode,200,human.body);
});
test("a client is limited to three account requests per hour and other clients are not", async () => {
  const from=async(ip:string)=>app.inject({method:"POST",url:"/api/account-requests",headers:{"x-forwarded-for":ip},payload:{email:"reader@example.com",username:"ratelimited"}});
  assert.equal((await from("203.0.113.150")).statusCode,200);
  assert.equal((await from("203.0.113.150")).statusCode,200);
  assert.equal((await from("203.0.113.150")).statusCode,200);
  const blocked=await from("203.0.113.150");
  assert.equal(blocked.statusCode,429,blocked.body);
  const fresh=await from("203.0.113.151");
  assert.equal(fresh.statusCode,200,fresh.body);
});
test("only an administrator can list the pending account requests", async () => {
  const admin=(await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":"203.0.113.160"},payload:{password:"admin-password"}})).cookies[0].value;
  const created=(await app.inject({method:"POST",url:"/api/users",cookies:{sonder_session:admin},payload:{username:"reviewer",password:"password1"}}));
  assert.equal(created.statusCode,200,created.body);
  const user=(await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":"203.0.113.161"},payload:{username:"reviewer",password:"password1"}})).cookies[0].value;
  const anon=await app.inject({method:"GET",url:"/api/account-requests"});
  assert.equal(anon.statusCode,401,anon.body);
  const denied=await app.inject({method:"GET",url:"/api/account-requests",cookies:{sonder_session:user}});
  assert.equal(denied.statusCode,403,denied.body);
  const visible=await app.inject({method:"GET",url:"/api/account-requests",cookies:{sonder_session:admin}});
  assert.equal(visible.statusCode,200,visible.body);
  const queue=visible.json();
  assert.ok(Array.isArray(queue));
  assert.ok(queue.some((r:any)=>r.username==="newreader"&&r.email==="reader@example.com"&&r.note==="Heard about you from a friend"));
  for(const row of queue) for(const field of ["id","email","username","note","createdAt"]) assert.ok(field in row,field);
  assert.ok(queue.every((r:any)=>typeof r.id==="number"&&typeof r.createdAt==="number"));
  // A reviewed row leaves the queue while its applicant details stay intact.
  const reviewed=(sqlite.prepare("SELECT id FROM account_requests WHERE username='honeypot-free'").get() as {id:number}).id;
  sqlite.prepare("UPDATE account_requests SET status='approved',reviewed_at=? WHERE id=?").run(Date.now(),reviewed);
  const after=(await app.inject({method:"GET",url:"/api/account-requests",cookies:{sonder_session:admin}})).json();
  assert.ok(!after.some((r:any)=>r.id===reviewed));
  assert.ok(after.some((r:any)=>r.username==="newreader"));
});
// #168: Resend dispatch, approval and decline. The email environment is
// configured per test and restored afterwards, and the outbound HTTPS call is
// stubbed by swapping the runtime fetch, as the other server tests do.
const realFetch=globalThis.fetch;
const {hashToken}=await import("../server/security.ts");
const emailEnv:Record<string,string|undefined>={RESEND_API_KEY:process.env.RESEND_API_KEY,EMAIL_FROM:process.env.EMAIL_FROM,ADMIN_EMAIL:process.env.ADMIN_EMAIL,APP_URL:process.env.APP_URL};
after(()=>{
  globalThis.fetch=realFetch;
  for(const [name,value] of Object.entries(emailEnv)) value===undefined?delete process.env[name]:(process.env[name]=value);
});
const stubDispatch=(responder:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>)=>{
  const calls:{url:string;init:RequestInit}[]=[];
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(input),init:init??{}});return responder(input,init);}) as typeof fetch;
  return calls;
};
const okEmail=()=>new Response("{}",{status:200});
const adminSession=async()=> (await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":"203.0.113.170"},payload:{password:"admin-password"}})).cookies[0].value;
const admin=(await adminSession());
const asAdmin=(url:string)=>app.inject({method:"POST",url,cookies:{sonder_session:admin},payload:{}});
test("submitting an account request alerts the administrator with the requester details", async () => {
  process.env.RESEND_API_KEY="re_test_key";
  process.env.EMAIL_FROM="Sonder <noreply@sonder.pecori.no>";
  process.env.ADMIN_EMAIL="admin@sonder.pecori.no";
  const calls=stubDispatch(async()=>okEmail());
  const res=await submit({email:"alerted@example.com",username:"alerted",note:"Please add me"});
  assert.equal(res.statusCode,200,res.body);
  const row=sqlite.prepare("SELECT * FROM account_requests WHERE username='alerted'").get() as any;
  assert.equal(row.status,"pending");
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,"https://api.resend.com/emails");
  assert.equal((calls[0].init.headers as any)["Authorization"],"Bearer re_test_key");
  const body=JSON.parse(calls[0].init.body as string);
  assert.equal(body.from,"Sonder <noreply@sonder.pecori.no>");
  assert.equal(body.to,"admin@sonder.pecori.no");
  assert.ok(body.subject.includes("alerted"),body.subject);
  assert.ok(body.text.includes("alerted@example.com"),body.text);
  assert.ok(body.text.includes("Please add me"),body.text);
});
test("a failing email dispatch never blocks request storage", async () => {
  process.env.RESEND_API_KEY="re_test_key";
  process.env.EMAIL_FROM="Sonder <noreply@sonder.pecori.no>";
  process.env.ADMIN_EMAIL="admin@sonder.pecori.no";
  globalThis.fetch=(async()=>{throw new Error("network unreachable");}) as typeof fetch;
  const res=await submit({email:"noemail@example.com",username:"noemail"});
  assert.equal(res.statusCode,200,res.body);
  const row=sqlite.prepare("SELECT * FROM account_requests WHERE username='noemail'").get() as any;
  assert.equal(row.status,"pending");
});
test("without Resend configuration the request is stored and nothing is sent", async () => {
  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.ADMIN_EMAIL;
  const calls=stubDispatch(async()=>okEmail());
  const res=await submit({email:"plain@example.com",username:"plain"});
  assert.equal(res.statusCode,200,res.body);
  assert.ok(sqlite.prepare("SELECT id FROM account_requests WHERE username='plain'").get());
  assert.equal(calls.length,0);
});
test("an administrator can decline a pending request without any outbound email", async () => {
  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.ADMIN_EMAIL;
  await submit({email:"declined@example.com",username:"declined"});
  const id=(sqlite.prepare("SELECT id FROM account_requests WHERE username='declined'").get() as {id:number}).id;
  const calls=stubDispatch(async()=>okEmail());
  const anon=await app.inject({method:"POST",url:`/api/account-requests/${id}/decline`,payload:{}});
  assert.equal(anon.statusCode,401,anon.body);
  const user=(await app.inject({method:"POST",url:"/api/auth/login",headers:{"x-forwarded-for":"203.0.113.171"},payload:{username:"reviewer",password:"password1"}})).cookies[0].value;
  const denied=await app.inject({method:"POST",url:`/api/account-requests/${id}/decline`,cookies:{sonder_session:user},payload:{}});
  assert.equal(denied.statusCode,403,denied.body);
  const res=await asAdmin(`/api/account-requests/${id}/decline`);
  assert.equal(res.statusCode,200,res.body);
  assert.deepEqual(res.json(),{ok:true});
  const row=sqlite.prepare("SELECT * FROM account_requests WHERE id=?").get(id) as any;
  assert.equal(row.status,"declined");
  assert.ok(row.reviewed_at>0);
  assert.equal(calls.length,0);
  const queue=(await app.inject({method:"GET",url:"/api/account-requests",cookies:{sonder_session:admin}})).json();
  assert.ok(!queue.some((r:any)=>r.id===id));
  const missing=await asAdmin("/api/account-requests/999999/decline");
  assert.equal(missing.statusCode,404,missing.body);
});
const pendingRequest=async(username:string)=>{
  await submit({email:`${username}@example.com`,username});
  return (sqlite.prepare("SELECT id FROM account_requests WHERE username=?").get(username) as {id:number}).id;
};
const extractToken=(link:string)=>new URL(link).searchParams.get("token");
test("approving a request creates a 7-day hashed invite and emails the link to the applicant", async () => {
  process.env.RESEND_API_KEY="re_test_key";
  process.env.EMAIL_FROM="Sonder <noreply@sonder.pecori.no>";
  delete process.env.APP_URL;
  const id=await pendingRequest("invitee");
  const calls=stubDispatch(async()=>okEmail());
  const before=Date.now();
  const res=await asAdmin(`/api/account-requests/${id}/approve`);
  const afterNow=Date.now();
  assert.equal(res.statusCode,200,res.body);
  const result=res.json();
  assert.equal(result.ok,true);
  assert.equal(result.emailDelivered,true);
  assert.match(result.inviteLink as string,/^http:\/\/localhost:3001\/join\?token=[0-9a-f]{64}$/);
  const token=extractToken(result.inviteLink as string);
  assert.match(token as string,/^[0-9a-f]{64}$/);
  const invite=sqlite.prepare("SELECT * FROM account_invites WHERE account_request_id=?").get(id) as any;
  assert.equal(invite.email,"invitee@example.com");
  assert.equal(invite.username,"invitee");
  assert.equal(invite.token,hashToken(token as string));
  assert.equal(invite.claimed_at,null);
  assert.ok(invite.created_at>=before&&invite.created_at<=afterNow);
  assert.equal(invite.expires_at-invite.created_at,7*24*3600000);
  const request=sqlite.prepare("SELECT * FROM account_requests WHERE id=?").get(id) as any;
  assert.equal(request.status,"approved");
  assert.ok(request.reviewed_at>0);
  assert.equal(request.invite_id,invite.id);
  assert.equal(calls.length,1);
  const body=JSON.parse(calls[0].init.body as string);
  assert.equal(body.to,"invitee@example.com");
  assert.ok(body.text.includes(result.inviteLink),body.text);
});
test("the invite link uses APP_URL when it is set", async () => {
  process.env.RESEND_API_KEY="re_test_key";
  process.env.EMAIL_FROM="Sonder <noreply@sonder.pecori.no>";
  process.env.APP_URL="https://sonder.pecori.no/";
  const id=await pendingRequest("appurl");
  stubDispatch(async()=>okEmail());
  const res=await asAdmin(`/api/account-requests/${id}/approve`);
  assert.equal(res.statusCode,200,res.body);
  const link=res.json().inviteLink as string;
  assert.match(link,/^https:\/\/sonder\.pecori\.no\/join\?token=[0-9a-f]{64}$/);
});
test("approval succeeds with emailDelivered false when Resend is unconfigured", async () => {
  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.APP_URL;
  const id=await pendingRequest("nokey");
  const calls=stubDispatch(async()=>okEmail());
  const res=await asAdmin(`/api/account-requests/${id}/approve`);
  assert.equal(res.statusCode,200,res.body);
  const result=res.json();
  assert.equal(result.ok,true);
  assert.equal(result.emailDelivered,false);
  assert.match(result.inviteLink as string,/^http:\/\/localhost:3001\/join\?token=[0-9a-f]{64}$/);
  assert.equal(calls.length,0);
  const request=sqlite.prepare("SELECT * FROM account_requests WHERE id=?").get(id) as any;
  assert.equal(request.status,"approved");
  assert.ok(sqlite.prepare("SELECT id FROM account_invites WHERE account_request_id=?").get(id));
});
test("approval succeeds with emailDelivered false when the dispatch fails", async () => {
  process.env.RESEND_API_KEY="re_test_key";
  process.env.EMAIL_FROM="Sonder <noreply@sonder.pecori.no>";
  delete process.env.APP_URL;
  const id=await pendingRequest("nofetch");
  globalThis.fetch=(async()=>{throw new Error("network unreachable");}) as typeof fetch;
  const res=await asAdmin(`/api/account-requests/${id}/approve`);
  assert.equal(res.statusCode,200,res.body);
  const result=res.json();
  assert.equal(result.ok,true);
  assert.equal(result.emailDelivered,false);
  assert.match(result.inviteLink as string,/^http:\/\/localhost:3001\/join\?token=[0-9a-f]{64}$/);
  const request=sqlite.prepare("SELECT * FROM account_requests WHERE id=?").get(id) as any;
  assert.equal(request.status,"approved");
});
test("an already reviewed request cannot be reviewed again and approval is admin only", async () => {
  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.APP_URL;
  const id=await pendingRequest("twice");
  stubDispatch(async()=>okEmail());
  const first=await asAdmin(`/api/account-requests/${id}/approve`);
  assert.equal(first.statusCode,200,first.body);
  const rawToken=extractToken(first.json().inviteLink as string);
  const again=await asAdmin(`/api/account-requests/${id}/approve`);
  assert.equal(again.statusCode,409,again.body);
  const anon=await app.inject({method:"POST",url:`/api/account-requests/${id}/approve`,payload:{}});
  assert.equal(anon.statusCode,401,anon.body);
  const missing=await asAdmin("/api/account-requests/999999/approve");
  assert.equal(missing.statusCode,404,missing.body);
  // The raw token never reaches the database; only its hash does.
  const tokens=sqlite.prepare("SELECT token FROM account_invites").all() as {token:string}[];
  assert.ok(!tokens.some((row)=>row.token===rawToken));
  assert.ok(tokens.some((row)=>row.token===hashToken(rawToken as string)));
});
