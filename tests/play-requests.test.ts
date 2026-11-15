import assert from "node:assert/strict";
import test from "node:test";
import { playRequests } from "../src/play-requests.ts";

test("a pause while a load waits keeps the load and lands it paused (#419: Undo, then Pause)", () => {
  const requests = playRequests();
  // Listen from here, then its Undo: the Undo's load still waits for the saved progress and the plan.
  const listen = requests.start(true);
  listen.landed();
  const undo = requests.start(true);
  requests.pause();
  assert.equal(undo.current(), true, "the pause did not give up the Undo's move back");
  assert.equal(undo.autoplay(), false, "the Undo lands paused");
  assert.equal(listen.current(), false);
});

test("a pause once the load landed is a newer request, as before", () => {
  const requests = playRequests();
  const load = requests.start(true);
  load.landed();
  const before = requests.current;
  requests.pause();
  assert.equal(requests.current, before + 1);
  assert.equal(load.current(), false);
});

test("playing again while a paused load waits lands it playing; nothing else is resumed", () => {
  const requests = playRequests();
  const load = requests.start(true);
  requests.pause();
  assert.equal(requests.resume(), true);
  assert.equal(load.autoplay(), true);
  assert.equal(load.current(), true);
  assert.equal(requests.resume(), false, "a load that is not paused is left alone");
  // A load that was never going to play (preparing the player) is not started by a play.
  const prepare = requests.start(false);
  requests.pause();
  assert.equal(requests.resume(), false);
  assert.equal(prepare.autoplay(), false);
  // Once landed, a play is the element's own.
  const landed = requests.start(true);
  requests.pause();
  landed.landed();
  assert.equal(requests.resume(), false);
});

test("a newer load still supersedes a waiting one, and cancel stops it", () => {
  const requests = playRequests();
  const first = requests.start(true);
  const second = requests.start(true);
  assert.equal(first.current(), false);
  // The older load landing late does not release the newer one.
  first.landed();
  requests.pause();
  assert.equal(second.current(), true);
  assert.equal(second.autoplay(), false);
  requests.cancel();
  assert.equal(second.current(), false);
});
