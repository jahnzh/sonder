import { test, after } from "node:test";
import assert from "node:assert/strict";
process.env.RESEND_API_KEY = "re_test_key";
process.env.EMAIL_FROM = "Sonder <noreply@sonder.pecori.no>";
const { sendResendEmail } = await import("../server/resend.ts");
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});
test("sendResendEmail posts the configured sender, key and message to Resend", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
  }) as typeof fetch;
  const result = await sendResendEmail({
    to: "admin@sonder.pecori.no",
    subject: "New account request: newreader",
    text: "newreader requested an account.",
  });
  assert.deepEqual(result, { delivered: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer re_test_key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    from: "Sonder <noreply@sonder.pecori.no>",
    to: "admin@sonder.pecori.no",
    subject: "New account request: newreader",
    text: "newreader requested an account.",
  });
});
test("sendResendEmail sends nothing when the API key or sender is unconfigured", async () => {
  const savedKey = process.env.RESEND_API_KEY;
  const savedFrom = process.env.EMAIL_FROM;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  delete process.env.RESEND_API_KEY;
  assert.deepEqual(await sendResendEmail({ to: "a@b.c", subject: "s", text: "t" }), { delivered: false });
  process.env.RESEND_API_KEY = savedKey;
  delete process.env.EMAIL_FROM;
  assert.deepEqual(await sendResendEmail({ to: "a@b.c", subject: "s", text: "t" }), { delivered: false });
  process.env.EMAIL_FROM = savedFrom;
  assert.equal(calls, 0);
});
test("sendResendEmail reports not delivered when Resend answers with an error status", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "invalid api key" }), { status: 403 })) as typeof fetch;
  assert.deepEqual(await sendResendEmail({ to: "a@b.c", subject: "s", text: "t" }), { delivered: false });
});
test("sendResendEmail reports not delivered when the network call throws", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network unreachable");
  }) as typeof fetch;
  assert.deepEqual(await sendResendEmail({ to: "a@b.c", subject: "s", text: "t" }), { delivered: false });
});
