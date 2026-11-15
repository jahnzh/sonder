import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReaderControls, waitForBox } from "../scripts/live-reader-controls.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

// A virtual clock: waiting advances time, so no test sleeps.
function clock() {
  let now = 0;
  return { clock: () => now, wait: async (ms) => { now += ms; } };
}

const box = (x = 10, y = 20, width = 100, height = 40) => ({ x, y, width, height });

// A locator whose boundingBox() returns the queued answers, then repeats the last one.
function boxes(...answers) {
  let index = 0;
  return {
    reads: () => index,
    boundingBox: async () => {
      const answer = answers[Math.min(index++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test("waitForBox skips null and empty boxes and returns once two reads agree", async () => {
  const timing = clock();
  const locator = boxes(null, box(0, 0, 0, 0), box(0, 0, 0, 0), box(10, 20), box(10, 20));
  assert.deepEqual(await waitForBox(locator, timing), box(10, 20));
  assert.equal(locator.reads(), 5);
});

test("waitForBox waits for a moving element to stop", async () => {
  const timing = clock();
  const locator = boxes(box(10, 20), box(10, 30), box(10, 40), box(10, 50), box(10, 50));
  assert.deepEqual(await waitForBox(locator, timing), box(10, 50));
});

test("waitForBox treats a Playwright timeout as not there yet and rethrows other errors", async () => {
  const timing = clock();
  const slow = boxes(new Error("locator.boundingBox: Timeout 1000ms exceeded."), box(), box());
  assert.deepEqual(await waitForBox(slow, timing), box());
  await assert.rejects(waitForBox(boxes(new Error("strict mode violation")), clock()), /strict mode violation/);
});

test("waitForBox names the element when it never appears or never settles", async () => {
  await assert.rejects(waitForBox(boxes(null), { ...clock(), timeout: 1000, description: "Pause narration" }), /Pause narration has no stable bounding box after 1000 ms$/);
  let y = 0;
  const moving = { boundingBox: async () => box(0, (y += 10)) };
  await assert.rejects(waitForBox(moving, { ...clock(), timeout: 1000, description: "slider" }), /slider .* \(it keeps moving\)/);
});

// A reader room: the top bar toggles on a tap, as in Reader.tsx. `swallow` taps are lost, `delay` is how long a tap takes to show the bar.
function reader({ visible = false, swallow = 0, delay = 0, lyrics = false, hasRoom = true, time }) {
  const state = { visible, taps: [], evaluated: 0, pending: [] };
  const apply = () => {
    for (const item of state.pending.filter((entry) => entry.at <= time.clock())) { state.visible = !state.visible; state.pending.splice(state.pending.indexOf(item), 1); }
  };
  const press = () => {
    state.taps.push(time.clock());
    if (state.swallowed < swallow) { state.swallowed += 1; return; }
    state.pending.push({ at: time.clock() + delay });
  };
  state.swallowed = 0;
  const topbar = { isVisible: async () => { apply(); return state.visible; } };
  const viewport = { boundingBox: async () => box(0, 0, 390, 700) };
  const lyricsSurface = { count: async () => (lyrics ? 1 : 0), evaluate: async (fn) => { state.evaluated += 1; press(); } };
  const room = {
    count: async () => (hasRoom ? 1 : 0),
    locator: (selector) => ({ ".reader-topbar": topbar, ".reader-viewport": viewport, ".lyrics-reader": lyricsSurface }[selector]),
  };
  const page = { mouse: { click: async (x, y) => { state.lastTap = { x, y }; press(); } } };
  return { state, room, page };
}

const controlsFor = (options) => {
  const time = clock();
  const fake = reader({ ...options, time });
  return { ...fake, time, controls: createReaderControls({ page: fake.page, room: fake.room, ...time }) };
};

test("show does not tap when the bar is already shown (a tap would hide it)", async () => {
  const { controls, state } = controlsFor({ visible: true });
  await controls.show();
  assert.equal(state.taps.length, 0);
});

test("show taps the middle of the page once when the bar is hidden", async () => {
  const { controls, state } = controlsFor({});
  await controls.show();
  assert.equal(state.taps.length, 1);
  assert.deepEqual(state.lastTap, { x: 195, y: 350 });
  assert.equal(state.visible, true);
});

test("show waits for a slow tap instead of tapping again and hiding the bar", async () => {
  const { controls, state } = controlsFor({ delay: 800 });
  await controls.show();
  assert.equal(state.taps.length, 1);
  assert.equal(state.visible, true);
});

test("show repeats a swallowed tap, at a different point", async () => {
  const { controls, state } = controlsFor({ swallow: 2 });
  await controls.show();
  assert.equal(state.taps.length, 3);
  assert.equal(state.visible, true);
  assert.notDeepEqual(state.lastTap, { x: 195, y: 350 });
});

test("show fails when the bar never appears, saying how many taps it made", async () => {
  const { controls, state } = controlsFor({ swallow: 1000 });
  await assert.rejects(controls.show(), /Reader controls did not appear after \d+ tap\(s\)/);
  assert.ok(state.taps.length >= 2);
});

test("show uses the Lyrics surface click instead of the mouse in Lyrics mode", async () => {
  const { controls, state } = controlsFor({ lyrics: true });
  await controls.show();
  assert.equal(state.evaluated, 1);
  assert.equal(state.lastTap, undefined);
  assert.equal(state.visible, true);
});

test("show without a reader room only waits for the control", async () => {
  const { controls, state } = controlsFor({ hasRoom: false });
  await controls.show(boxes(box(), box()), "slider");
  assert.equal(state.taps.length, 0);
});

test("show waits until the control has a stable box after the bar appears", async () => {
  const { controls } = controlsFor({});
  const control = boxes(null, box(0, 700), box(0, 640), box(0, 640));
  await controls.show(control, "Pause narration");
  assert.equal(control.reads(), 4);
});

test("hide taps only while the bar is shown", async () => {
  const shown = controlsFor({ visible: true });
  await shown.controls.hide();
  assert.equal(shown.state.visible, false);
  assert.equal(shown.state.taps.length, 1);
  const hidden = controlsFor({});
  await hidden.controls.hide();
  assert.equal(hidden.state.taps.length, 0);
});

function clickable({ failures = 0 } = {}) {
  const control = boxes(box(), box());
  control.clicks = 0;
  control.click = async () => {
    control.clicks += 1;
    if (control.clicks <= failures) throw new Error("click: element is not visible");
  };
  return control;
}

test("click reveals the controls, waits for the control and clicks it once", async () => {
  const { controls, state } = controlsFor({});
  const control = clickable();
  await controls.click(control, "Pause narration");
  assert.equal(state.visible, true);
  assert.equal(control.clicks, 1);
});

test("click starts again from the reveal when the click fails because the bar hid", async () => {
  const { controls, state } = controlsFor({});
  const control = clickable({ failures: 1 });
  const click = control.click;
  control.click = async (...args) => {
    if (control.clicks === 0) state.visible = false;
    return click(...args);
  };
  await controls.click(control, "More");
  assert.equal(control.clicks, 2);
  assert.equal(state.taps.length, 2);
  assert.equal(state.visible, true);
});

test("click gives up after its attempts and names the control", async () => {
  const { controls } = controlsFor({ visible: true });
  const control = clickable({ failures: 99 });
  await assert.rejects(controls.click(control, "Close reader"), /Close reader: click: element is not visible/);
  assert.equal(control.clicks, 3);
});

// The live scripts must keep using the helper: the failures of #413 were each a bare click or measurement.
const read = (name) => fs.readFileSync(path.join(scripts, name), "utf8");
for (const name of ["verify-integrated-reader.mjs", "verify-playback-workflow.mjs"]) {
  test(`${name} measures nothing with a bare boundingBox()`, () => {
    assert.doesNotMatch(read(name), /\.boundingBox\(/);
  });
  test(`${name} clicks reader controls only through the helper`, () => {
    const source = read(name);
    assert.match(source, /createReaderControls/);
    assert.doesNotMatch(source, /reader-topbar'?"?\)[^;\n]*\.click\(/);
    assert.doesNotMatch(source, /(?:pause|play)\.click\(/);
    assert.doesNotMatch(source, /page\.mouse\.click/);
  });
}

test("the integrated reader check waits for the current Lyrics line to exist and does not scroll it", () => {
  const source = read("verify-integrated-reader.mjs");
  assert.match(source, /currentLine\.count\(\)===1/);
  assert.doesNotMatch(source, /scrollIntoView|scrollTo|mouse\.wheel/);
});

test("the live scripts keep the browser-write guard", () => {
  for (const name of ["verify-integrated-reader.mjs", "verify-playback-workflow.mjs"]) {
    const source = read(name);
    assert.match(source, /protectBrowserMutations\(context,\s*baseURL,\s*report\)/);
    assert.match(source, /closeProtectedBrowser\(context,\s*browser,\s*report\)/);
  }
});
