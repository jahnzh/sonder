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
 * Wait until `locator` has a non-empty bounding box that is the same on two successful reads in a row.
 * `boundingBox()` is null while the element is hidden or detached: reading `.x` of that crashed the checks.
 *
 * Each read may take the whole remaining budget. Resolving a role locator costs time in proportion to the
 * page: in Lyrics mode every sentence of the book is a <button> (12,000 in a long book), and one
 * `getByRole("button", { name: "Pause narration" })` took about 3 s while playback re-rendered them. A fixed
 * 1 s limit per read made almost every read time out, so two good reads never came in a row although the
 * button never moved (#413). A read that runs out of time says nothing about where the element is, so it
 * keeps the previous box; a read that finds the element hidden (null) or zero-sized starts over.
 */
export async function waitForBox(locator, { timeout = 25000, interval = 100, description = "element", wait = sleep, clock = Date.now } = {}) {
  const deadline = clock() + timeout;
  let previous = null;
  let last = "no read";
  for (;;) {
    let box = null;
    let timedOut = false;
    try {
      box = await locator.boundingBox({ timeout: Math.max(1, deadline - clock()) });
    } catch (error) {
      // Playwright throws a timeout when no element matched in time; any other error is real.
      if (!/timeout/i.test(String(error?.message))) throw error;
      timedOut = true;
    }
    if (timedOut) last = "no element matched in time";
    else if (!box) {
      previous = null;
      last = "hidden";
    } else if (!(box.width > 0 && box.height > 0)) {
      previous = null;
      last = "zero-sized";
    } else if (previous && sameBox(previous, box)) return box;
    else {
      last = previous ? "it keeps moving" : "one read so far";
      previous = box;
    }
    if (clock() >= deadline) throw new Error(`${description} has no stable bounding box after ${timeout} ms (last read: ${last})`);
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
    const box = await waitForBox(room.locator(".reader-viewport"), { timeout, description: "reader viewport", ...timing });
    const fraction = fractions[taps % fractions.length];
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
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

  /** Turn the page with a tap on its right (next) or left (previous) edge, outside the band that toggles the controls. */
  const turn = async (direction = "next") => {
    const box = await waitForBox(room.locator(".reader-viewport"), { timeout, description: "reader viewport", ...timing });
    await page.mouse.click(box.x + box.width * (direction === "next" ? 0.9 : 0.1), box.y + box.height / 2);
  };

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

  return { show, hide, click, turn, topbar };
}

/**
 * Whether the narrated-sentence highlight is drawn on the page the reader shows (`room` is a `.reader-room`).
 * The EPUB frame is as wide as its chapter's columns and the reader's viewport clips it to one page, so the
 * highlight is rendered (Playwright's toBeVisible holds) on any page of the chapter: this measures each of its
 * rectangles against the viewport instead (#501 review). The browser specs use the same measure.
 */
export function narratedOnPage(room) {
  return room.locator(".reader-viewport").evaluate((host) => {
    const bounds = host.getBoundingClientRect();
    for (const mark of host.querySelectorAll(".sonder-follow")) {
      for (const rect of [...mark.querySelectorAll("rect")].map((r) => r.getBoundingClientRect())) {
        const width = Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left);
        const height = Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top);
        if (width > 2 && height > 2) return true;
      }
    }
    return false;
  });
}
