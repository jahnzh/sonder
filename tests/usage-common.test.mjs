import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub } from "../scripts/usage-common.mjs";

test("scrub redacts sensitive key=value, key: value and JSON-quoted pairs in free text", () => {
  const userId = "987654321";
  const samples = [
    `userId=${userId}`,
    `user_id: ${userId}`,
    `"userId":${userId}`,
    `'userId': '${userId}'`,
    `accountId=${userId}`,
    `orgId: ${userId}`,
    `teamId=${userId}`,
    `session=deadbeefsessiontoken0000000001`,
    `cookie: sid=abc`,
  ];
  for (const sample of samples) {
    const out = scrub(sample);
    assert.equal(out.includes(userId), false, `scrub left user id in ${sample}: ${out}`);
    assert.match(out, /<redacted>/);
  }
  assert.equal(scrub(`user ${userId}`).includes(userId), false);
  assert.equal(scrub(`https://api.cursor.com/users/${userId}?userId=${userId}`).includes(userId), false);
});

test("scrub redacts Windows home paths and wsl$ paths in free text", () => {
  const win = String.raw`C:\Users\win-user\AppData\Roaming\cursor`;
  const wsl = String.raw`\\wsl$\Ubuntu\home\wsl-user\.claude`;
  const wslLocal = String.raw`\\wsl.localhost\Ubuntu\home\wsl-user`;
  for (const sample of [win, wsl, wslLocal, `failed at ${win}`, `open ${wsl}`]) {
    const out = scrub(sample);
    assert.equal(out.includes("win-user"), false, `scrub left Windows user in ${sample}: ${out}`);
    assert.equal(out.includes("wsl-user"), false, `scrub left wsl user in ${sample}: ${out}`);
    assert.match(out, /<redacted>/);
  }
});

test("scrub redacts Cookie/Set-Cookie/Authorization headers and long opaque blobs", () => {
  const cookieVal = "sessionid=abcdefghijklmnopqrstuvwxyz012345";
  const authVal = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
  const hexBlob = "0123456789abcdef0123456789abcdef01234567";
  const b64Blob = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwYWJjZA==";
  assert.equal(scrub(`Cookie: ${cookieVal}`).includes(cookieVal), false);
  assert.equal(scrub(`Set-Cookie: ${cookieVal}; Path=/`).includes("abcdefghijklmnopqrstuvwxyz012345"), false);
  assert.equal(scrub(`Authorization: ${authVal}`).includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false);
  assert.equal(scrub(`token blob ${hexBlob}`).includes(hexBlob), false);
  assert.equal(scrub(`opaque ${b64Blob}`).includes(b64Blob), false);
});
