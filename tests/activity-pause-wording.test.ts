/**
 * What pausing a process does is one text for the Activity page and the design's tooltip of the same queue (#495).
 * The design's list is `docs/design/redesign/tools/tips.mjs`; the server cannot import it, so the words are written
 * in `server/activity-pause-model.ts` and this test keeps the two identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error the design's tools are plain JavaScript without declarations
import { T } from "../docs/design/redesign/tools/tips.mjs";
import { PAUSABLE_PROCESSES, PAUSE_EFFECT } from "../server/activity-pause-model.ts";

const TOOLTIP_OF_QUEUE: Record<(typeof PAUSABLE_PROCESSES)[number], string> = {
  acquisitions: "downloadQueue",
  "server-copies": "copies",
  "series-acquisition": "seriesSearch",
  alignment: "syncQueue",
  "ebook-set": "ebookChecks",
  backups: "backups",
};

test("the six pause sentences are the design's tooltips for the six queues", () => {
  assert.equal(PAUSABLE_PROCESSES.length, 6);
  assert.deepEqual(Object.keys(TOOLTIP_OF_QUEUE).sort(), [...PAUSABLE_PROCESSES].sort(), "every pausable process has a tooltip");
  for (const id of PAUSABLE_PROCESSES) {
    const tooltip = (T as Record<string, string>)[TOOLTIP_OF_QUEUE[id]];
    assert.equal(typeof tooltip, "string", `the design has the tooltip ${TOOLTIP_OF_QUEUE[id]}`);
    assert.equal(PAUSE_EFFECT[id], tooltip, id);
  }
  assert.equal(PAUSE_EFFECT.alignment, "Off: no new reading sync starts. One that is running finishes.");
});
