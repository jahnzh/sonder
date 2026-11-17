import { test } from "node:test";
import assert from "node:assert/strict";
import { accountAnswer } from "../src/account-answer.ts";

// The Library's saved series and Hardcover state are read per account (#597): an answer to a request started as
// one account that arrives after another signed in on the same device is neither shown nor kept for the new one.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("an answer for the account still signed in is returned and kept for it alone", async () => {
  let account = 1;
  const answers = accountAnswer<string[]>(() => account);
  assert.equal(answers.kept(), undefined);
  assert.deepEqual(await answers.read(async () => ["A's series"]), { value: ["A's series"] });
  assert.deepEqual(answers.kept(), ["A's series"]);
  account = 2;
  assert.equal(answers.kept(), undefined, "another account does not start from A's");
  account = 1;
  assert.deepEqual(answers.kept(), ["A's series"]);
});

test("an answer that arrives after another account signed in is dropped, and the new account's is kept", async () => {
  let account = 1;
  const answers = accountAnswer<string[]>(() => account);
  const slow = deferred<string[]>();
  const asked = answers.read(() => slow.promise);
  // A's session ends and B signs in while A's request is out.
  account = 2;
  const own = await answers.read(async () => ["B's series"]);
  assert.deepEqual(own, { value: ["B's series"] });
  slow.resolve(["A's series"]);
  assert.equal(await asked, null);
  assert.deepEqual(answers.kept(), ["B's series"], "A's late answer is not stored under B");
  account = 1;
  assert.equal(answers.kept(), undefined, "nor under A, whose request outlived its session");
});

test("the account is read when the request starts, not when it answers", async () => {
  let account = 2;
  const answers = accountAnswer<string>(() => account);
  const slow = deferred<string>();
  // Started as B; A signs in and then B again before the answer: B is the one signed in, so it is B's.
  const asked = answers.read(() => slow.promise);
  account = 1;
  account = 2;
  slow.resolve("B's state");
  assert.deepEqual(await asked, { value: "B's state" });
  const late = deferred<string>();
  const other = answers.read(() => late.promise);
  account = 1;
  late.resolve("B's newer state");
  assert.equal(await other, null);
  assert.equal(answers.kept(), undefined);
});

test("a failure of a request for another account is dropped too; one for the account signed in is thrown", async () => {
  let account = 1;
  const answers = accountAnswer<string>(() => account);
  const slow = deferred<string>();
  const asked = answers.read(() => slow.promise);
  account = 2;
  slow.reject(new Error("Sign in again."));
  assert.equal(await asked, null);
  await assert.rejects(answers.read(async () => Promise.reject(new Error("offline"))), /offline/);
});
