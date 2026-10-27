import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./db.ts";
const keyFile = join(dataDir, ".encryption-key");
if (!existsSync(keyFile))
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
const key = createHash("sha256")
  .update(process.env.ENCRYPTION_KEY || readFileSync(keyFile))
  .digest();
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    body.toString("hex"),
  ].join(":");
}
export function decrypt(value: string) {
  const [iv, tag, body] = value.split(":");
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  cipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    cipher.update(Buffer.from(body, "hex")),
    cipher.final(),
  ]).toString("utf8");
}
export function passwordMatches(input: string) {
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256")
    .update(process.env.APP_PASSWORD || "")
    .digest();
  return timingSafeEqual(a, b);
}
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
