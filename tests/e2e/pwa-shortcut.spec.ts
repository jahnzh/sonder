import { test, expect } from "./fixtures";
import { androidScreenshot, androidUiDump, androidShell, pressAndroidBack } from "../android/fixtures";
import { writeFileSync } from "node:fs";
// Issue #85 (and #84): add the app to the Android home screen from Firefox's menu, launch it from the icon and press the
// system Back key. Firefox for Android 159 on http://127.0.0.1 offers "Add to Home screen" (a shortcut that opens a normal
// Firefox tab); a true installed app ("Add app to homepage" on a phone, standalone window) needs a secure origin. Android and Firefox only.
test.skip(process.env.SONDER_ANDROID_BROWSER !== "firefox", "needs Firefox for Android on the emulator");

// The centre of the first node whose text or description matches `label`.
function find(xml: string, label: RegExp) {
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const n = m[0];
    const text = /\stext="([^"]*)"/.exec(n)?.[1] ?? "";
    const desc = /content-desc="([^"]*)"/.exec(n)?.[1] ?? "";
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);
    if (b && (label.test(text) || label.test(desc))) return { x: Math.round((+b[1] + +b[3]) / 2), y: Math.round((+b[2] + +b[4]) / 2) };
  }
  return null;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the home-screen shortcut opens the app, and Back leaves it without a stuck screen", async ({ page }) => {
  const shot = (name: string) => androidScreenshot(test.info().outputPath(`${name}.png`));
  const focus = async () => String(await androidShell("dumpsys window | grep mCurrentFocus | head -1"));
  // Dumps the screen, taps the node matching `label` and fails with the dump saved when it is not there.
  const tap = async (label: RegExp, step: string) => {
    const xml = await androidUiDump();
    writeFileSync(test.info().outputPath(`${step.replace(/\W+/g, "-")}.xml`), xml);
    const hit = find(xml, label);
    expect(hit, `${step}: ${label} is on the screen`).not.toBeNull();
    await androidShell(`input tap ${hit!.x} ${hit!.y}`);
    await wait(1500);
  };

  await page.goto("/#library");
  // The tab bar's Settings (#581; the drawer and its Settings button went).
  await expect(page.getByRole("navigation", { name: "Main", exact: true }).getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await androidShell("input tap 672 112"); // the toolbar's three-dot menu
  await wait(1500);
  await tap(/^More/, "open More");
  await tap(/^Add to Home screen/, "Add to Home screen");
  await tap(/^ADD$/i, "confirm the name");
  await tap(/^Add to home screen$/i, "confirm in the launcher");
  await androidShell("input keyevent KEYCODE_HOME");
  await wait(2000);
  await tap(/Sonder/i, "launch the icon");
  await wait(5000);

  // The shortcut opens the app in Firefox, which shows the library (its Title "Library", #577).
  expect(await focus()).toContain("org.mozilla.firefox");
  expect(find(await androidUiDump(), /^Library$/)).not.toBeNull();
  await shot("launched");

  // One Back goes to Firefox's start page (its search field is showing), never to a blank or stuck screen.
  await pressAndroidBack();
  await wait(2500);
  await shot("back-1");
  expect(await focus()).toContain("org.mozilla.firefox");
  const start = await androidUiDump();
  expect(find(start, /Search or enter address|^Search$/), "Firefox's start page is showing").not.toBeNull();
  expect(find(start, /^Library$/), "the app is no longer on screen").toBeNull();

  // A second Back leaves Firefox for the launcher.
  await pressAndroidBack();
  await wait(2500);
  await shot("back-2");
  expect(await focus()).toContain("launcher");
});
