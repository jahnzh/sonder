// The live checks click only what exists (#617): no removed screen, class or text, and every class and accessible
// name a check looks for is in the app's source. A fixture tree in a temporary folder, then the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.ts";
import { accessibleNames, readTree, selectorClasses, staleLocators } from "../scripts/live-check-locators.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(files) {
  const dir = tempDir("sonder-live-locators-");
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return readTree(dir);
}

const APP = {
  "src/pages/page.tsx": `<div className="reader-room inline-reader"><button aria-label="Close reader" /></div>`,
  "src/parts/back.ts": "export const back = (page: string) => `Back to ${page}`; export const SYNC = 'Reading sync';",
};

test("a check that names only what the app has passes", () => {
  const tree = fixture({
    ...APP,
    "scripts/verify-reader.mjs": `const room=page.locator('.inline-reader');await room.getByRole('button',{name:'Close reader',exact:true}).click();await page.getByRole("button",{name:"Back to Reading sync"}).click();`,
    "scripts/live-reader-controls.mjs": `export const head=room=>room.locator(".reader-room");`,
    "scripts/other-tool.mjs": "the More sheet, .topbar", // not a live check
  });
  assert.deepEqual(staleLocators(tree), []);
});

test("a removed name, a class the app lost and a name no control has are reported", () => {
  const tree = fixture({
    ...APP,
    "scripts/verify-old.mjs": [
      "// Open the More sheet.",
      "await page.locator('.topbar .reader-more').click();",
      `await page.getByRole('button',{name:'Versions & sources',exact:true}).click();`,
      `const leaked=books.filter(b=>b.id.startsWith('hc-'));`,
      `document.querySelector('.drawer-panel');`,
      `await page.getByLabel('Your home server').fill('x');`,
      `await page.getByRole('button',{name:'Playback options'}).click();`,
      `await page.getByRole('button',{name:'Back to Nowhere'}).click();`,
      // Part of a longer name is not the name of a control.
      `await page.getByRole('button',{name:'Close',exact:true}).click();`,
    ].join("\n"),
  });
  const found = staleLocators(tree).map(({ kind, value }) => `${kind}:${value}`).sort();
  assert.deepEqual(found, [
    "class:drawer-panel",
    "class:reader-more",
    "class:topbar",
    "name:Back to Nowhere",
    "name:Close",
    "name:Playback options",
    "name:Versions & sources",
    "name:Your home server",
    "removed:.topbar",
    "removed:More sheet",
    "removed:Playback options",
    "removed:Versions & sources",
    "removed:Your home server",
    "removed:drawer",
    "removed:hc-",
  ]);
});

test("selectors and names are read as the checks write them", () => {
  assert.deepEqual(selectorClasses(`page.locator(".player-dock .dock-book");room.locator('.reader-room:not(.inline-reader)');document.querySelectorAll('.inline-reader .sonder-follow')`), [
    "player-dock",
    "dock-book",
    "reader-room",
    "inline-reader",
    "sonder-follow",
  ]);
  // A template or a pattern is not a plain name: it is not checked.
  assert.deepEqual(accessibleNames("getByRole('button',{name:'Play',exact:true});getByRole(\"radio\",{name:\"Open this book’s page\"});getByRole('button',{name:`Recording ${x}`});getByRole('slider',{name:/^Seek in /});getByLabel('Username')"), [
    "Play",
    "Open this book’s page",
    "Username",
  ]);
});

test("the live checks in this checkout name only screens, classes and controls the app has", () => {
  const tree = readTree(root);
  assert.deepEqual(
    Object.keys(tree.scripts).sort(),
    ["live-reader-controls.mjs", "verify-covers.mjs", "verify-integrated-reader.mjs", "verify-multi-user-snapshot.mjs", "verify-multi-user.mjs", "verify-playback-workflow.mjs", "verify-reading-sync.mjs", "verify-slice-pass.mjs"],
  );
  assert.deepEqual(staleLocators(tree), []);
});
