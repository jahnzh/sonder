import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatEbookDeviceSuffix,
  workEbookOnDevice,
} from "../src/series-ebook-device.ts";

test("workEbookOnDevice uses offline edition ids only", () => {
  const offline = new Set(["epub-a", "epub-b"]);
  assert.equal(workEbookOnDevice(["epub-a"], offline), true);
  assert.equal(workEbookOnDevice(["server-only"], offline), false);
  assert.equal(workEbookOnDevice(undefined, offline), false);
  assert.equal(workEbookOnDevice([], offline), false);
});

test("formatEbookDeviceSuffix labels client offline state", () => {
  assert.equal(formatEbookDeviceSuffix(true), " · on device");
  assert.equal(formatEbookDeviceSuffix(false), " · not on device");
});
