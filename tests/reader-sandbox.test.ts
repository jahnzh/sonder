import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isWebKitEngine, probeReaderSandbox, readerNeedsScripts, scriptsRequired } from "../src/reader-sandbox";

function fixture(options: {
  blocked?: string[];
  load?: "success" | "error" | "timeout";
  missingTarget?: boolean;
  missingPointerEvent?: boolean;
  appendThrows?: boolean;
} = {}) {
  const listeners = new Map<string, () => void>();
  const attributes = new Map<string, string>();
  let removed = 0;
  let created = 0;
  const target = {
    dispatchEvent(event: Event) {
      if (!options.blocked?.includes(event.type) && event.bubbles) listeners.get(event.type)?.();
    },
  };
  const content = {
    getElementById: (id: string) => id === "reader-event-probe" && !options.missingTarget ? target : null,
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  };
  const frame = {
    style: { cssText: "" },
    tabIndex: 0,
    srcdoc: "",
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    contentDocument: content,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    remove: () => { removed++; },
  };
  const doc = {
    defaultView: { PointerEvent: options.missingPointerEvent ? undefined : Event, MouseEvent: Event },
    createElement: (tag: string) => { assert.equal(tag, "iframe"); created++; return frame; },
    body: {
      appendChild: () => {
        if (options.appendThrows) throw new Error("cannot append");
        if (options.load === "timeout") return;
        queueMicrotask(() => options.load === "error" ? frame.onerror?.() : frame.onload?.());
      },
    },
  } as unknown as Document;
  return { doc, frame, attributes, removed: () => removed, created: () => created };
}

test("scriptless frames are used only when every reader event reaches parent listeners", async () => {
  for (const blocked of [[], ["pointerdown"], ["pointerup"], ["click"]]) {
    const probe = fixture({ blocked });
    assert.equal(await probeReaderSandbox(probe.doc), blocked.length !== 0, blocked.join(",") || "all events");
    assert.equal(probe.attributes.get("sandbox"), "allow-same-origin");
    assert.equal(probe.removed(), 1);
  }
});

test("an unavailable or inconclusive probe keeps scripts enabled", async () => {
  for (const options of [
    { missingTarget: true },
    { missingPointerEvent: true },
    { appendThrows: true },
    { load: "error" as const },
    { load: "timeout" as const },
  ]) {
    const probe = fixture(options);
    assert.equal(await probeReaderSandbox(probe.doc, 5), true, JSON.stringify(options));
    assert.equal(probe.removed(), 1);
  }
});

test("reader instances share the pending and completed sandbox probe", async () => {
  const probe = fixture();
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: probe.doc, configurable: true });
  try {
    const first = readerNeedsScripts();
    assert.equal(readerNeedsScripts(), first);
    assert.equal(await first, false);
    assert.equal(readerNeedsScripts(), first);
    assert.equal(probe.created(), 1);
    assert.equal(probe.removed(), 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("Safari and every iOS browser count as WebKit, other engines do not", () => {
  const webkit = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  ];
  for (const agent of webkit) assert.equal(isWebKitEngine(agent), true, agent);
  // iPadOS asks for the desktop site and reports a Mac with a touch screen.
  assert.equal(isWebKitEngine("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5), true);
  const other = [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
    "Node.js/24",
  ];
  for (const agent of other) assert.equal(isWebKitEngine(agent), false, agent);
  assert.equal(isWebKitEngine("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0), false);
});

test("a WebKit user agent keeps scripts on even when the probe says they are not needed", () => {
  const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", platform: "iPhone", maxTouchPoints: 5 };
  const chrome = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", platform: "Linux x86_64", maxTouchPoints: 0 };
  assert.equal(scriptsRequired(false, iphone), true);
  assert.equal(scriptsRequired(true, chrome), true);
  assert.equal(scriptsRequired(false, chrome), false);
  assert.equal(scriptsRequired(false, undefined), false);
});
