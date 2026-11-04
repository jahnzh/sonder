import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sqlite } from "./db.ts";
import { decrypt, encrypt, hashToken } from "./security.ts";

export const ADMIN_USER_ID = 1;
export const USER_DATA_TABLES = [
  "sessions",
  "user_acquisitions",
  "user_settings",
  "user_library",
  "user_hidden_library",
  "user_progress",
  "user_ebook_progress",
  "user_reader_checkpoints",
  "user_reader_bookmarks",
  "user_reader_events",
  "work_media_states",
  "user_hardcover_links",
  "user_hardcover_outbox",
  "user_hardcover_reading_outbox",
  "user_hardcover_progress",
  "user_hardcover_lists",
  "user_hardcover_reads",
  "user_hardcover_recording_editions",
  "user_saved_series_works",
  "user_saved_series",
  "series_acquisition_jobs",
  "user_work_completion",
] as const;
export type User = { id: number; username: string; role: "admin" | "user" };
declare module "fastify" { interface FastifyRequest { user: User | null } }
const admin: User = { id: 1, username: "admin", role: "admin" };
export function sessionUser(req: FastifyRequest): User | null {
  if (!process.env.APP_PASSWORD) return admin;
  const token = req.cookies.sonder_session;
  if (!token) return null;
  return (sqlite.prepare("SELECT u.id,u.username,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?").get(hashToken(token), Date.now()) as User | undefined) ?? null;
}
export function currentUser(req: FastifyRequest): User { const user = req.user ?? sessionUser(req); if (!user) throw Object.assign(new Error("Sign in to your listening space."), { statusCode: 401 }); return user; }
export function currentUserId(req: FastifyRequest): number { return currentUser(req).id; }
export function requireAdmin(req: FastifyRequest): void {
  if (currentUser(req).role !== "admin") throw Object.assign(new Error("Only the administrator can do this."), { statusCode: 403 });
}
export function userIsAdmin(userId: number) {
  if (userId === ADMIN_USER_ID) return true;
  const row = sqlite
    .prepare("SELECT role FROM users WHERE id=?")
    .get(userId) as { role: User["role"] } | undefined;
  return row?.role === "admin";
}
export function getUserSetting(userId: number, key: string): string { return (sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key=?").get(userId,key) as {value:string} | undefined)?.value || ""; }
export function setUserSetting(userId: number, key: string, value: string): void {
  if (!value) sqlite.prepare("DELETE FROM user_settings WHERE user_id=? AND key=?").run(userId,key);
  else sqlite.prepare("INSERT INTO user_settings(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").run(userId,key,value);
}
export function getUserSecret(userId: number, key: string): string { const value=getUserSetting(userId,key); return value ? decrypt(value) : ""; }
export function setUserSecret(userId: number, key: string, value: string): void { setUserSetting(userId,key,value ? encrypt(value) : ""); }
export function listUserIds(): number[] { return (sqlite.prepare("SELECT id FROM users ORDER BY id").all() as {id:number}[]).map(row=>row.id); }
export function hashPassword(password: string): string { const salt=randomBytes(16); return `scrypt$${salt.toString("base64")}$${scryptSync(password,salt,64).toString("base64")}`; }
export function verifyPassword(password: string, encoded: string | null): boolean {
  if (!encoded) return false;
  try { const [algorithm,salt,hash]=encoded.split("$"); if (algorithm !== "scrypt" || !salt || !hash) return false; const expected=Buffer.from(hash,"base64"); if (expected.length !== 64) return false; return timingSafeEqual(expected,scryptSync(password,Buffer.from(salt,"base64"),64)); } catch { return false; }
}
const deletionHooks = new Set<(userId: number) => void>();
export function onUserDeleted(cb: (userId: number) => void): () => void { deletionHooks.add(cb); return () => deletionHooks.delete(cb); }
// Ids are never reused: device storage is keyed by user id. Before the mark existed,
// deleted accounts could leave rows behind, so the mark starts above every id seen in
// users, sessions and the per-user tables.
function userIdHighWater(): number {
  const stored=(sqlite.prepare("SELECT value FROM settings WHERE key='user_id_high_water'").get() as {value:string}|undefined)?.value;
  if (stored) return Number(stored);
  const tables=(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name='sessions' OR name LIKE 'user\\_%' ESCAPE '\\')").all() as {name:string}[])
    .filter(({name})=>(sqlite.prepare(`PRAGMA table_info("${name}")`).all() as {name:string}[]).some(c=>c.name==="user_id"));
  const seen=[(sqlite.prepare("SELECT COALESCE(MAX(id),1) AS id FROM users").get() as {id:number}).id,
    ...tables.map(({name})=>(sqlite.prepare(`SELECT COALESCE(MAX(user_id),1) AS id FROM "${name}"`).get() as {id:number}).id)];
  return setUserIdHighWater(Math.max(1,...seen));
}
function setUserIdHighWater(id: number): number { sqlite.prepare("INSERT INTO settings(key,value) VALUES('user_id_high_water',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(id)); return id; }
export const passwordSchema=z.string().min(8).max(512);
// Ids are never reused and the high water mark moves up in the same statement
// batch as the insert, so callers wrap this in their own transaction when it
// must stand or fall with other writes (POST /api/users, invite claims).
export function createUser(username: string, password: string): number {
  const max=(sqlite.prepare("SELECT COALESCE(MAX(id), 1) AS id FROM users").get() as {id:number}).id;
  const next=Math.max(max,userIdHighWater())+1;
  sqlite.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)").run(next,username,hashPassword(password),"user",Date.now());
  setUserIdHighWater(next);
  return next;
}
export function registerUsers(app: FastifyInstance): void {
  userIdHighWater();
  app.get("/api/users", req => { requireAdmin(req); return sqlite.prepare("SELECT id,username,role,created_at AS createdAt FROM users ORDER BY id").all(); });
  app.post("/api/users", req => {
    requireAdmin(req);
    const input=z.object({username:z.string().min(2).max(40).regex(/^[a-z0-9._-]+$/i),password:passwordSchema,role:z.literal("user").default("user")}).parse(req.body);
    if(input.username.toLowerCase()==="admin") throw new Error("That username is reserved.");
    const id=sqlite.transaction(() => createUser(input.username,input.password))();
    return sqlite.prepare("SELECT id,username,role,created_at AS createdAt FROM users WHERE id=?").get(id);
  });
  app.patch("/api/users/:id", req => {
    requireAdmin(req); const id=Number((req.params as {id:string}).id); if(id===1) throw new Error("The administrator account cannot be modified.");
    const input=z.object({password:passwordSchema.optional(),role:z.literal("user").optional()}).parse(req.body);
    if (!sqlite.prepare("SELECT id FROM users WHERE id=?").get(id)) throw new Error("User not found.");
    sqlite.transaction(() => { if(input.password) { sqlite.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(input.password),id); sqlite.prepare("DELETE FROM sessions WHERE user_id=?").run(id); } if(input.role) sqlite.prepare("UPDATE users SET role=? WHERE id=?").run(input.role,id); })(); return {ok:true};
  });
  app.delete("/api/users/:id", req => { requireAdmin(req); const id=Number((req.params as {id:string}).id); if(id===1) throw new Error("The administrator account cannot be deleted."); sqlite.transaction(()=>{ const exists=sqlite.prepare("SELECT id FROM users WHERE id=?").get(id); if (!exists) return; setUserIdHighWater(Math.max(userIdHighWater(),id)); for(const table of USER_DATA_TABLES) sqlite.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id); sqlite.prepare("DELETE FROM users WHERE id=?").run(id); for (const cb of deletionHooks) cb(id); })(); return {ok:true}; });
  app.post("/api/auth/password", req => { const user=currentUser(req); if(user.id===1) throw new Error("The administrator password is configured with APP_PASSWORD."); const input=z.object({currentPassword:z.string().max(512),newPassword:passwordSchema}).parse(req.body); const row=sqlite.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id) as {password_hash:string}; if(!verifyPassword(input.currentPassword,row.password_hash)) throw new Error("The current password does not match."); sqlite.transaction(() => { sqlite.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(input.newPassword),user.id); sqlite.prepare("DELETE FROM sessions WHERE user_id=? AND token<>?").run(user.id,hashToken(req.cookies.sonder_session || "")); })(); return {ok:true}; });
}
