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

test("waitForBox names the element and what the last read saw when it never settles", async () => {
  await assert.rejects(waitForBox(boxes(null), { ...clock(), timeout: 1000, description: "Pause narration" }), /^Error: Pause narration has no stable bounding box after 1000 ms \(last read: hidden\)$/);
  await assert.rejects(waitForBox(boxes(box(0, 0, 0, 0)), { ...clock(), timeout: 1000, description: "Pause narration" }), /\(last read: zero-sized\)$/);
  let y = 0;
  const moving = { boundingBox: async () => box(0, (y += 10)) };
  await assert.rejects(waitForBox(moving, { ...clock(), timeout: 1000, description: "slider" }), /slider .* \(last read: it keeps moving\)$/);
  const missing = boxes(new Error("locator.boundingBox: Timeout 1000ms exceeded."));
  await assert.rejects(waitForBox(missing, { ...clock(), timeout: 1000, description: "Pause narration" }), /\(last read: no element matched in time\)$/);
});

// #413: in Lyrics mode every sentence of the book is a <button>; resolving getByRole("button", { name: "Pause narration" })
// over 12,000 of them took about 3 s per read while playback re-rendered them (measured on the local repro server).
// A locator whose every read costs `cost` ms of the virtual clock, honouring the timeout it is given like Playwright does.
function slowLocator(timing, cost, answer = box()) {
  const options = [];
  return {
    options,
    boundingBox: async (option) => {
      options.push(option);
      if (option.timeout < cost) {
        await timing.wait(option.timeout);
        throw new Error(`locator.boundingBox: Timeout ${option.timeout}ms exceeded.`);
      }
      await timing.wait(cost);
      return answer;
    },
  };
}

test("waitForBox gives each read the remaining budget, so a slow role query still settles (#413)", async () => {
  const timing = clock();
  const pause = slowLocator(timing, 3000);
  assert.deepEqual(await waitForBox(pause, { ...timing, description: "Pause narration" }), box());
  assert.equal(pause.options.length, 2);
  assert.equal(pause.options[0].timeout, 25000);
  assert.equal(pause.options[1].timeout, 25000 - 3000 - 100);
  assert.equal(timing.clock(), 6100);
});

test("waitForBox still fails when even one read cannot finish within the budget", async () => {
  const timing = clock();
  const pause = slowLocator(timing, 30000);
  await assert.rejects(waitForBox(pause, { ...timing, description: "Pause narration" }), /after 25000 ms \(last read: no element matched in time\)$/);
});

test("a read that runs out of time between two good reads keeps the box it had (#413)", async () => {
  const timing = clock();
  const pause = boxes(box(), new Error("locator.boundingBox: Timeout 1000ms exceeded."), new Error("locator.boundingBox: Timeout 1000ms exceeded."), box());
  assert.deepEqual(await waitForBox(pause, { ...timing, description: "Pause narration" }), box());
  assert.equal(pause.reads(), 4);
  assert.ok(timing.clock() < 1000, `settled after ${timing.clock()} ms, not at the 25 s deadline`);
});

test("a control that is hidden between two good reads is read again until it is shown twice in a row", async () => {
  const timing = clock();
  const pause = boxes(box(), null, box(), box());
  assert.deepEqual(await waitForBox(pause, timing), box());
  assert.equal(pause.reads(), 4);
});

// A reader room: the top bar toggles on a tap, as in Reader.tsx. `swallow` taps are lost, `delay` is how long a tap takes to show the bar.
function reader({ visible = false, swallow = 0, delay = 0, hasRoom = true, time }) {
  const state = { visible, taps: [], pending: [] };
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
  const room = {
    count: async () => (hasRoom ? 1 : 0),
    locator: (selector) => ({ ".reader-topbar": topbar, ".reader-viewport": viewport }[selector]),
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

test("the integrated reader check looks for Play and Pause narration in the player bar only (#413)", () => {
  const source = read("verify-integrated-reader.mjs");
  assert.match(source, /player=room\.locator\('\.reader-player'\),play=player\.getByRole\('button',\{name:'Play narration',exact:true\}\),pause=player\.getByRole\('button',\{name:'Pause narration',exact:true\}\)/);
  assert.doesNotMatch(source, /(?:room|page)\.getByRole\('button',\{name:'(?:Play|Pause) narration'/);
});

test("the integrated reader check waits for the narrated highlight after the desktop resize and does not scroll the pages", () => {
  const source = read("verify-integrated-reader.mjs");
  assert.match(source, /narrated\.count\(\)>0\)return true;\s*await seek\(middle\.middle\);return false;/);
  assert.doesNotMatch(source, /scrollIntoView|scrollTo|mouse\.wheel/);
});

// The reader has one view (ADR 0017): the live check no longer opens Lyrics, and checks that no view switch is offered.
test("the integrated reader check clicks no removed view and checks that none is offered", () => {
  const source = read("verify-integrated-reader.mjs");
  assert.doesNotMatch(source, /lyrics-line|lyrics-reader|getByRole\('button',\{name:'(?:Lyrics|Word)',exact:true\}\)\.click|display:'book'/);
  assert.match(source, /getByRole\('group',\{name:'Reading mode',exact:true\}\)\)\.toHaveCount\(0\)/);
});

test("the live scripts keep the browser-write guard", () => {
  for (const name of ["verify-integrated-reader.mjs", "verify-playback-workflow.mjs"]) {
    const source = read(name);
    assert.match(source, /protectBrowserMutations\(context,\s*baseURL,\s*report\)/);
    assert.match(source, /closeProtectedBrowser\(context,\s*browser,\s*report\)/);
  }
});
