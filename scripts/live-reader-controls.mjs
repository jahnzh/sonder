// Helpers for the live reader checks (#413): reveal the reader's controls, wait for the control to be laid out, then use it.
//
// What the product does (src/components/Reader.tsx, src/reader.css):
// - The top bar (Close reader, More, ...) is `<header class="reader-topbar" hidden={!controls}>` and
//   `controls = controlsVisible || desktop`. On a phone-width screen `controlsVisible` starts false.
// - There is no hide timer. A tap in the middle 30-70% of the page (or on the Lyrics surface, outside
//   a button) TOGGLES `controlsVisible`: tapping while the bar is shown hides it again. The state also
//   resets to false whenever the reader remounts (opening it, closing it) and Close reader sets it false.
// - The player bar (Play/Pause narration, seek slider) is always rendered, but its grid changes when the
//   controls toggle (the info row and the scrubber appear), so its buttons move while the layout settles.
// - A page tap only registers once the EPUB iframe has attached its pointer handlers; before that the
//   tap is swallowed and the bar stays hidden.
// So a click on a control must (1) tap only while the bar is hidden, (2) confirm that it appeared, retrying
// a swallowed tap, and (3) wait for the control to have a stable box before clicking.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sameBox = (a, b) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/**
 * Wait until `locator` has a non-empty bounding box that is the same on two reads in a row.
 * `boundingBox()` is null while the element is hidden or detached: reading `.x` of that crashed the checks.
 */
export async function waitForBox(locator, { timeout = 25000, interval = 100, description = "element", wait = sleep, clock = Date.now } = {}) {
  const deadline = clock() + timeout;
  let previous = null;
  for (;;) {
    let box = null;
    try {
      box = await locator.boundingBox({ timeout: 1000 });
    } catch (error) {
      // Playwright throws a timeout when the element does not exist yet; any other error is real.
      if (!/timeout/i.test(String(error?.message))) throw error;
    }
    if (box && box.width > 0 && box.height > 0) {
      if (previous && sameBox(previous, box)) return box;
      previous = box;
    } else previous = null;
    if (clock() >= deadline) throw new Error(`${description} has no stable bounding box after ${timeout} ms${previous ? " (it keeps moving)" : ""}`);
    await wait(interval);
  }
}

async function waitUntil(predicate, { timeout, interval = 50, wait = sleep, clock = Date.now }) {
  const deadline = clock() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (clock() >= deadline) return false;
    await wait(interval);
  }
}

/**
 * Controls for the reader room (`room` is the `.inline-reader` locator). `page` supplies the mouse.
 * `timeout` bounds each reveal; `settle` is how long a tap may take to show the bar before it counts as swallowed.
 */
export function createReaderControls({ page, room, timeout = 25000, settle = 1500, attempts = 3, wait = sleep, clock = Date.now }) {
  const topbar = room.locator(".reader-topbar");
  const timing = { wait, clock };
  // Points inside the 30-70% band that toggles the controls; a retry presses elsewhere in case a link or image took the tap.
  const fractions = [0.5, 0.42, 0.58];
  let taps = 0;

  const tap = async () => {
    const lyrics = room.locator(".lyrics-reader");
    if (await lyrics.count()) {
      // The Lyrics surface toggles the controls on a click that is not on a button.
      await lyrics.evaluate((el) => el.click());
    } else {
      const box = await waitForBox(room.locator(".reader-viewport"), { timeout, description: "reader viewport", ...timing });
      const fraction = fractions[taps % fractions.length];
      await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
    }
    taps += 1;
  };

  const settleTo = (visible) => waitUntil(async () => (await topbar.isVisible()) === visible, { timeout: settle, ...timing });

  // Toggle until the top bar is in the wanted state. The state is checked before every tap: a tap on a shown bar hides it.
  const setBar = async (visible) => {
    if (!(await room.count())) return false;
    const deadline = clock() + timeout;
    for (;;) {
      if ((await topbar.isVisible()) === visible) return true;
      if (clock() >= deadline) throw new Error(`Reader controls did not ${visible ? "appear" : "hide"} after ${taps} tap(s)`);
      await tap();
      await settleTo(visible);
    }
  };

  /** Show the top bar and player controls; with `control`, also wait until it has a stable box. */
  const show = async (control, description = "control") => {
    const present = await setBar(true);
    if (control) await waitForBox(control, { timeout, description, ...timing });
    return present;
  };

  /** Hide the top bar again (the long-press check needs the page clear of it). */
  const hide = () => setBar(false);

  /**
   * Reveal the controls, wait for `control` to be stable and click it. A click that fails because the
   * controls hid or the layout moved in between is repeated from the reveal.
   */
  const click = async (control, description = "control") => {
    let last;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await show(control, description);
        await control.click({ timeout: 5000 });
        return;
      } catch (error) {
        last = error;
      }
    }
    throw new Error(`${description}: ${last?.message ?? last}`);
  };

  return { show, hide, click, topbar };
}
