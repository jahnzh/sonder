// @projects firefox
// Prepared text in a browser's own parser (#801, review of #809). The unit tests read the server's output with the
// parser that wrote it, which cannot show where a browser reads the same string another way. Here the parts of a
// book made of the review's hostile chapters are served by the real routes and put into a live page with innerHTML
// (the page has no Content-Security-Policy, so nothing but the server's sanitising stands between the book and the
// page) and through DOMParser, and the page's DOM is walked: every element and attribute against the allow-list the
// server and the reader share (src/prepared-text-rules.ts), no script run, no request made, the sentences in order
// with their stored text, and as many characters as the manifest counts.
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hostileCases, hostileFiles, preparedFixture } from "../prepared-text-fixture";
import { refusedElement, type PreparedElementLike } from "../../src/prepared-text-rules";
import { normalizeReaderText } from "../../src/reading-types";

const made: string[] = [];
test.afterEach(async ({ page }) => {
  for (const workId of made.splice(0)) await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`).catch(() => {});
});

type Seen = { elements: PreparedElementLike[]; parsed: PreparedElementLike[]; otherNodes: number; chars: number; spans: [string, string][] };

test("a hostile book's prepared parts hold only allowed nodes in a browser, and run nothing", async ({ page }) => {
  const chapters: Record<string, string> = { "plain.xhtml": "<h1>Plain</h1><p>A plain chapter. With two sentences.</p>" };
  for (const [name, body] of Object.entries(hostileCases)) chapters[`${name}.xhtml`] = body;
  chapters["rel.xhtml"] = "<p>Rel.</p>";
  const epub = await preparedFixture({ files: hostileFiles, chapters });
  const imported = await page.request.post("/api/ebooks/import", {
    multipart: { file: { name: `Hostile ${randomBytes(3).toString("hex")}.epub`, mimeType: "application/epub+zip", buffer: epub } },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const id = (await imported.json()).id as string;
  const ebook = ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((entry) => entry.id === id)!;
  made.push(ebook.workId);

  const manifestResponse = await page.request.get(`/api/reader/${encodeURIComponent(id)}/prepared`);
  expect(manifestResponse.ok(), await manifestResponse.text()).toBe(true);
  const manifest = (await manifestResponse.json()) as { key: string; problems: string[]; parts: { index: number; chars: number }[] };
  expect(manifest.problems).toEqual([]);
  const base = `/api/reader/${encodeURIComponent(id)}/prepared/${manifest.key}`;
  const parts: string[] = [];
  for (const part of manifest.parts) {
    const response = await page.request.get(`${base}/parts/${part.index}`);
    expect(response.headers()["cache-control"]).toBe("private, max-age=31536000, immutable");
    parts.push(await response.text());
  }
  const book = (await (await page.request.get(`/api/reader/${encodeURIComponent(id)}`)).json()) as { sections: { paragraphs: { id: string; text: string }[] }[] };
  const stored = book.sections.flatMap((section) => section.paragraphs.map((paragraph) => [paragraph.id, normalizeReaderText(paragraph.text.replace(/\u0000/g, ""))]));
  expect(stored.length).toBeGreaterThan(50);

  // A page of its own, without the app's policy: what a part could do there, it could do.
  await page.goto("about:blank");
  await page.setContent('<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>');
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const seen = await page.evaluate(async (htmls) => {
    const win = window as unknown as { fired: string[]; canary?: number };
    win.fired = [];
    window.alert = (message) => void win.fired.push(String(message));
    const describe = (root: ParentNode) =>
      [...root.querySelectorAll("*")].map((element) => ({
        localName: element.localName,
        namespaceURI: element.namespaceURI,
        attributes: [...element.attributes].map((attribute) => ({ name: attribute.name, value: attribute.value })),
      }));
    const out: Seen[] = [];
    for (const html of htmls) {
      const host = document.createElement("div");
      document.body.append(host);
      host.innerHTML = html;
      // Comments, CDATA sections and processing instructions: none may reach the page.
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_CDATA_SECTION);
      let otherNodes = 0;
      while (walker.nextNode()) otherNodes++;
      // The second way a reader may take a part in: an inert document.
      const parsed = new DOMParser().parseFromString(html, "text/html");
      out.push({
        elements: describe(host),
        parsed: [...describe(parsed.head), ...describe(parsed.body)],
        otherNodes,
        chars: host.textContent!.length,
        spans: [...host.querySelectorAll("[data-s]")].map((span) => [span.getAttribute("data-s")!, span.textContent!]),
      });
    }
    // A picture that fails calls its handler: once this one has, any handler a part carried would have run too.
    const canary = document.createElement("div");
    document.body.append(canary);
    canary.innerHTML = '<img src="nothing:" onerror="window.canary=1">';
    await new Promise<void>((resolve) => {
      const wait = () => (win.canary === 1 ? resolve() : setTimeout(wait, 10));
      wait();
    });
    return { out, fired: win.fired, roots: document.querySelectorAll("#root").length, title: document.title, ownLocation: typeof document.location.href, forms: document.forms.length };
  }, parts);

  const refused: string[] = [];
  let elements = 0;
  seen.out.forEach((part, index) => {
    for (const element of [...part.elements, ...part.parsed]) {
      elements++;
      const why = refusedElement(element, base);
      if (why) refused.push(`part ${index}: ${why}`);
    }
    expect(part.otherNodes, `part ${index}: comment nodes`).toBe(0);
    expect(part.chars, `part ${index}: characters`).toBe(manifest.parts[index].chars);
    expect(part.parsed.length, `part ${index}: DOMParser and innerHTML agree`).toBe(part.elements.length);
    // The browser makes the elements the server wrote and no others (it adds a <tbody> to a table without one):
    // a <p> the server left around a block, say, would be closed early and come back as a second, empty one.
    const written = (parts[index].match(/<[a-z][a-z0-9]*/g) || []).filter((tag) => tag !== "<tbody").length;
    expect(part.elements.filter((element) => element.localName !== "tbody").length, `part ${index}: elements written`).toBe(written);
  });
  expect(refused).toEqual([]);
  expect(elements).toBeGreaterThan(500);
  // Nothing ran, nothing was asked for, and no element shadowed the page's own names.
  expect(seen.fired).toEqual([]);
  expect(dialogs).toEqual([]);
  // (Chromium reports the canary's own address as a request; nothing else may be asked for.)
  expect(requests.filter((url) => url !== "nothing:")).toEqual([]);
  expect([seen.roots, seen.title, seen.ownLocation, seen.forms]).toEqual([1, "t", "string", 0]);
  // The sentences, read from the page: each stored id once, in order, with its stored text.
  const sentences: [string, string][] = [];
  for (const [sentenceId, text] of seen.out.flatMap((part) => part.spans)) {
    const last = sentences[sentences.length - 1];
    if (last?.[0] === sentenceId) last[1] += text;
    else sentences.push([sentenceId, text]);
  }
  expect(sentences.map(([sentenceId, text]) => [sentenceId, normalizeReaderText(text)])).toEqual(stored);
});
