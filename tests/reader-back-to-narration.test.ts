import { test } from "node:test";
import assert from "node:assert/strict";
import { backToNarration, type BackToNarrationState } from "../src/reader-back-to-narration";

const state = (patch: Partial<BackToNarrationState>): BackToNarrationState => ({
  narration: true,
  sentence: true,
  following: false,
  admin: true,
  locating: false,
  ...patch,
});

test("with a narrated sentence it follows it, for anyone, and is off while already following", () => {
  assert.equal(backToNarration(state({})), "follow");
  assert.equal(backToNarration(state({ admin: false })), "follow");
  assert.equal(backToNarration(state({ following: true })), null);
  assert.equal(backToNarration(state({ following: true, admin: false })), null);
});

test("without a narrated sentence the administrator locates the passage, following or not", () => {
  assert.equal(backToNarration(state({ sentence: false })), "locate");
  assert.equal(backToNarration(state({ sentence: false, following: true })), "locate");
});

test("without a narrated sentence it is off for anyone but the administrator", () => {
  assert.equal(backToNarration(state({ sentence: false, admin: false })), null);
  assert.equal(backToNarration(state({ sentence: false, admin: false, following: true })), null);
});

test("it is off without this book's recording in the player, and while a locating runs", () => {
  assert.equal(backToNarration(state({ narration: false })), null);
  assert.equal(backToNarration(state({ narration: false, sentence: false })), null);
  assert.equal(backToNarration(state({ locating: true, sentence: false })), null);
  assert.equal(backToNarration(state({ locating: true })), null);
});
