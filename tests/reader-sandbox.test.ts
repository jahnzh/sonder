import { strict as assert } from "node:assert";
import { test } from "node:test";
import { probeReaderSandbox, readerNeedsScripts } from "../src/reader-sandbox";

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
