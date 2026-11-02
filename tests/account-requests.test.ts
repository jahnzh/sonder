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
