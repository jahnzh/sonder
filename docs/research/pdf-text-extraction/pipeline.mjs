#!/usr/bin/env node
// Throwaway spike for docs/research/pdf-text-extraction.md: turns the output of `pdftotext` into paragraphs and
// sentences in the id scheme of extractBook (server/reader.ts). Not application code.
//
// Usage: node pipeline.mjs <dir> [word list]
// <dir> holds bbox-layout.html (pdftotext -bbox-layout), raw.txt (pdftotext -raw) and outline.xml.
// It builds the book once per reading order and writes for each order ("layout", "raw", "geo"):
//   <order>.book.json, <order>.first200.txt, <order>.removed.txt, <order>.hyphens.txt, and both into stats.json.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [dir, dictPath] = process.argv.slice(2);
const started = performance.now();

// The two things extractBook's sentences depend on, copied: normalizeReaderText (src/reading-types.ts) and the segmenter.
const normalizeReaderText = (text) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

const entity = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (_, name, dec, hex) =>
    dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name.toLowerCase()],
  );
const box = (line) => {
  const m = /xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)"/.exec(line);
  return m ? { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] } : null;
};
const median = (values) => (values.length ? [...values].sort((a, b) => a - b)[values.length >> 1] : 0);
const quantile = (values, q) => (values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] : 0);
const letters = (text) => (text.match(/\p{L}/gu) || []).length;
const terminal = (text) => /[.!?…]["'”’»)\]]*$/.test(text.trim());
const lineOf = (words) => ({
  words,
  text: words.map((word) => word.t).join(" "),
  x0: Math.min(...words.map((word) => word.x0)),
  x1: Math.max(...words.map((word) => word.x1)),
  y0: median(words.map((word) => word.y0)),
  y1: median(words.map((word) => word.y1)),
});

// 1. Parse poppler's words with their boxes, in the order it wrote them (its own reading order).
const parsed = [];
{
  const input = readline.createInterface({ input: fs.createReadStream(path.join(dir, "bbox-layout.html")) });
  let page = null, line = null, blocks = 0, multiLineBlocks = 0, blockLines = 0;
  const endBlock = () => {
    if (blockLines > 1) multiLineBlocks++;
    blockLines = 0;
  };
  for await (const raw of input) {
    const text = raw.trimStart();
    if (text.startsWith("<word")) {
      const m = />([^<]*)<\/word>/.exec(text), b = box(text);
      if (line && m && b && m[1].trim()) line.push({ t: entity(m[1]), ...b });
    } else if (text.startsWith("<line")) {
      line = [];
      page.lines.push(line);
      blockLines++;
    } else if (text.startsWith("<block")) {
      endBlock();
      blocks++;
    } else if (text.startsWith("<page")) {
      const m = /width="([\d.]+)" height="([\d.]+)"/.exec(text);
      page = { w: +m[1], h: +m[2], lines: [] };
      parsed.push(page);
    }
  }
  endBlock();
  parsed.blocks = blocks;
  parsed.multiLineBlocks = multiLineBlocks;
}
const pageWords = parsed.map((page) => page.lines.reduce((n, line) => n + line.length, 0));
const pageLetters = parsed.map((page) => page.lines.reduce((n, line) => n + line.reduce((m, word) => m + letters(word.t), 0), 0));
const textPages = pageLetters.filter((count) => count >= 50).length;

// Layout order: poppler's lines, with the pieces of one printed line that it split into side-by-side blocks put back.
const layoutPages = parsed.map((page) => {
  const lines = [];
  for (const words of page.lines) {
    if (!words.length) continue;
    const next = lineOf(words), last = lines.at(-1);
    const overlap = last ? Math.min(last.y1, next.y1) - Math.max(last.y0, next.y0) : 0;
    if (last && overlap > 0.5 * Math.min(last.y1 - last.y0, next.y1 - next.y0) && next.x0 >= last.x1 - 1 && next.x0 - last.x1 < 3 * (last.y1 - last.y0))
      lines[lines.length - 1] = lineOf([...last.words, ...next.words]);
    else lines.push(next);
  }
  return { w: page.w, h: page.h, lines };
});

// Raw order: the lines of `pdftotext -raw` (the order of the page's content stream), each word given the box of
// the same word in the layout output.
const rawText = fs.existsSync(path.join(dir, "raw.txt")) ? fs.readFileSync(path.join(dir, "raw.txt"), "utf8").split("\f") : [];
let rawUnmatched = 0, rawWords = 0;
const rawPages = parsed.map((page, p) => {
  const pool = new Map();
  for (const word of page.lines.flat()) {
    if (!pool.has(word.t)) pool.set(word.t, []);
    pool.get(word.t).push(word);
  }
  const lines = [];
  for (const rawLine of (rawText[p] || "").split("\n")) {
    const texts = rawLine.split(/\s+/).filter(Boolean);
    if (!texts.length) continue;
    rawWords += texts.length;
    const found = texts.map((text) => (pool.get(text)?.length === 1 ? pool.get(text)[0] : null));
    const anchorY = median(found.filter(Boolean).map((word) => word.y0));
    let lastX = -Infinity;
    const words = [];
    texts.forEach((text, i) => {
      let word = found[i];
      if (!word) {
        const candidates = pool.get(text) || [];
        const anchor = found.some(Boolean) ? anchorY : (lines.at(-1)?.y1 ?? 0);
        word = [...candidates].sort((a, b) => Math.abs(a.y0 - anchor) + (a.x0 < lastX ? 1000 : 0) - (Math.abs(b.y0 - anchor) + (b.x0 < lastX ? 1000 : 0)) || a.x0 - b.x0)[0];
      }
      if (!word) return void rawUnmatched++;
      pool.get(text).splice(pool.get(text).indexOf(word), 1);
      lastX = word.x0;
      words.push(word);
    });
    if (words.length) lines.push(lineOf(words));
  }
  return { w: page.w, h: page.h, lines };
});

// Geometric order: ignore poppler's blocks; put the page's words into lines by their height on the page and read the
// lines top to bottom. Only right for a page with one column.
const geoPages = parsed.map((page) => {
  const lines = [];
  for (const word of page.lines.flat().sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1) || a.x0 - b.x0)) {
    const middle = (word.y0 + word.y1) / 2;
    const line = lines.findLast((candidate) => middle > candidate.y0 && middle < candidate.y1 && (candidate.y0 + candidate.y1) / 2 > word.y0 && (candidate.y0 + candidate.y1) / 2 < word.y1);
    if (line) {
      line.words.push(word);
      line.y0 = median(line.words.map((w) => w.y0));
      line.y1 = median(line.words.map((w) => w.y1));
    } else lines.push({ words: [word], y0: word.y0, y1: word.y1 });
  }
  return { w: page.w, h: page.h, lines: lines.sort((a, b) => a.y0 - b.y0).map((line) => lineOf(line.words.sort((a, b) => a.x0 - b.x0))) };
});

// Reading-order check: of the words that occur once on a page, the share that keeps its relative order between the two.
const orderScores = parsed
  .map((page, p) => {
    const layout = layoutPages[p].lines.flatMap((line) => line.words), raw = rawPages[p].lines.flatMap((line) => line.words);
    if (layout.length < 40 || raw.length < 40) return null;
    const count = (list) => list.reduce((map, word) => map.set(word.t, (map.get(word.t) || 0) + 1), new Map());
    const [inLayout, inRaw] = [count(layout), count(raw)];
    const rawAt = new Map(raw.map((word, i) => [word.t, i]));
    const sequence = layout.filter((word) => inLayout.get(word.t) === 1 && inRaw.get(word.t) === 1).map((word) => rawAt.get(word.t));
    if (sequence.length < 20) return null;
    const tails = [];
    for (const value of sequence) {
      let lo = 0, hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      tails[lo] = value;
    }
    return tails.length / sequence.length;
  })
  .filter((score) => score != null);

const outline = fs.existsSync(path.join(dir, "outline.xml"))
  ? [...fs.readFileSync(path.join(dir, "outline.xml"), "utf8").matchAll(/<item page="(\d+)">([^<]*)</g)].map((m) => ({ page: +m[1] - 1, title: entity(m[2]) }))
  : [];
const dictionary = dictPath ? new Set(fs.readFileSync(dictPath, "utf8").toLowerCase().split("\n")) : null;

function build(order, sourcePages) {
  const t0 = performance.now();
  const pages = sourcePages.map((page) => ({ ...page, lines: page.lines.map((line) => ({ ...line, h: line.y1 - line.y0 })) }));
  pages.forEach((page, p) => page.lines.forEach((line) => (line.p = p)));

  // Body text height: the line height that carries the most letters.
  const weight = new Map();
  for (const page of pages)
    for (const line of page.lines) {
      const key = Math.round(line.h * 2) / 2;
      weight.set(key, (weight.get(key) || 0) + letters(line.text));
    }
  const bodyH = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] || 12;

  // Rotated lines (margin stamps): far taller than the body text and much taller than wide.
  let rotated = 0;
  for (const page of pages)
    page.lines = page.lines.filter((line) => {
      const drop = line.h > 6 * bodyH && line.x1 - line.x0 < line.h / 4;
      if (drop) rotated++;
      return !drop;
    });

  // 2. Headers, footers and page numbers: one of the two highest lines in the top 15 % of the page, or of the three
  // lowest in the bottom 20 %, whose text, with digits replaced, recurs there on three pages or more; then any short
  // line at a height where half the pages have such a line.
  const furnitureKey = (text) => {
    const plain = text.toLowerCase().trim();
    if (/^[-–—\s[(]*[ivxlc]{1,8}[-–—\s\])]*$/.test(plain)) return "#";
    return plain.replace(/\d+/g, "#").replace(/[^\p{L}#]+/gu, " ").trim();
  };
  const zoneLines = [];
  pages.forEach((page, p) => {
    const top = page.lines.filter((line) => line.y1 <= page.h * 0.15).sort((a, b) => a.y0 - b.y0).slice(0, 2);
    const bottom = page.lines.filter((line) => line.y0 >= page.h * 0.8).sort((a, b) => b.y0 - a.y0).slice(0, 3);
    for (const line of top) zoneLines.push({ line, p, zone: "top", key: furnitureKey(line.text) });
    for (const line of bottom) zoneLines.push({ line, p, zone: "bottom", key: furnitureKey(line.text) });
  });
  const keyPages = new Map();
  for (const item of zoneLines) {
    const key = `${item.zone}|${item.key}`;
    if (!keyPages.has(key)) keyPages.set(key, new Set());
    keyPages.get(key).add(item.p);
  }
  // A recurring text only counts at a height that mostly holds recurring text: the last word of a paragraph can
  // recur at the top of three pages ("him."), but it sits where the body's first lines sit.
  const removedLines = new Set(), removedCount = new Map(), bucketPages = new Map(), bucketAll = new Map();
  const yBucket = (item) => `${item.zone}|${Math.round(item.line.y0 / 3)}`;
  for (const item of zoneLines) {
    bucketAll.set(yBucket(item), (bucketAll.get(yBucket(item)) || 0) + 1);
    if (item.key.length > 80 || keyPages.get(`${item.zone}|${item.key}`).size < 3) continue;
    item.recurs = true;
    if (!bucketPages.has(yBucket(item))) bucketPages.set(yBucket(item), new Set());
    bucketPages.get(yBucket(item)).add(item.p);
  }
  for (const item of zoneLines) {
    const here = bucketPages.get(yBucket(item))?.size || 0;
    const dominated = here >= 0.5 * bucketAll.get(yBucket(item));
    const byHeight = here >= textPages * 0.5 && item.line.words.length <= 12;
    if (!(item.recurs && (dominated || item.key === "#")) && !byHeight) continue;
    removedLines.add(item.line);
    const label = `${item.zone} ${item.recurs ? "recurs" : "height"} | ${item.key}`;
    removedCount.set(label, (removedCount.get(label) || 0) + 1);
  }
  const keptZone = zoneLines.filter((item) => !removedLines.has(item.line) && item.line.words.length <= 8);
  for (const page of pages) page.lines = page.lines.filter((line) => !removedLines.has(line));

  // A drop cap is its own tall line of one letter; put it back in front of the line it belongs to.
  let dropCaps = 0;
  for (const page of pages) {
    for (const cap of page.lines) {
      if (!(cap.h > 1.6 * bodyH && /^["'“‘]?\p{Lu}$/u.test(cap.text))) continue;
      const target = page.lines
        .filter((line) => line !== cap && line.x0 > cap.x0 && line.y0 < cap.y1 && line.y1 > cap.y0 && /^\p{L}/u.test(line.text))
        .sort((a, b) => a.y0 - b.y0)[0];
      if (!target) continue;
      target.text = cap.text + target.text;
      target.words = [{ ...target.words[0], t: cap.text + target.words[0].t }, ...target.words.slice(1)];
      cap.dropped = true;
      dropCaps++;
    }
    page.lines = page.lines.filter((line) => !line.dropped);
  }

  // 3. Columns, pitch and footnotes, per page.
  let multiColumnPages = 0, footnoteLines = 0;
  for (const page of pages) {
    const wide = page.lines.filter((line) => line.words.length >= 4);
    for (const line of page.lines) {
      const near = page.lines.filter((other) => Math.min(other.x1, line.x1) - Math.max(other.x0, line.x0) > 0.5 * Math.min(other.x1 - other.x0, line.x1 - line.x0));
      const widest = Math.max(...near.map((other) => other.x1 - other.x0));
      const column = near.filter((other) => other.x1 - other.x0 >= 0.7 * widest);
      line.left = median(column.map((other) => other.x0));
      line.right = quantile(column.map((other) => other.x1), 0.9);
    }
    if (wide.filter((a) => wide.some((b) => a.x1 < b.x0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0)).length >= 5) multiColumnPages++;
    const pitches = page.lines.slice(1).map((line, i) => line.y0 - page.lines[i].y0).filter((pitch) => pitch > 0.5 * bodyH && pitch < 3 * bodyH);
    page.pitch = pitches.length >= 3 ? median(pitches) : 1.3 * bodyH;
    let inNotes = false;
    for (const line of page.lines) {
      if (line.h < 0.88 * bodyH && line.y0 > page.h * 0.45 && (inNotes || /^(\d{1,3}|[*†‡§])\s?\S/.test(line.text))) {
        line.note = inNotes = true;
        footnoteLines++;
      }
    }
  }

  // 4. Paragraphs, from the geometry of consecutive lines.
  const fits = (prev, next) => prev.x1 + 0.35 * prev.h + (next.words[0].x1 - next.words[0].x0) < prev.right - 0.2 * prev.h;
  const paragraphs = [];
  const flows = { body: { current: null, prev: null }, note: { current: null, prev: null } };
  let heldNotes = [];
  const closeBody = () => {
    if (flows.body.current) paragraphs.push(flows.body.current);
    flows.body.current = null;
    if (flows.note.current) heldNotes.push(flows.note.current);
    flows.note.current = null;
    paragraphs.push(...heldNotes);
    heldNotes = [];
  };
  for (const page of pages)
    for (const line of page.lines) {
      const flow = line.note ? flows.note : flows.body, prev = flow.prev;
      let fresh = !prev || !flow.current;
      if (!fresh) {
        const sized = Math.abs(line.h - prev.h) / Math.max(line.h, prev.h) > 0.35;
        const indented = line.x0 - line.left > 0.7 * line.h && prev.x0 - prev.left < 0.7 * prev.h;
        const hyphen = /\p{L}[-­¬]$/u.test(prev.text) && /^\p{Ll}/u.test(line.text);
        const pitch = line.y0 - prev.y0;
        const jumped = line.p === prev.p && pitch > 0 && Math.abs(line.x0 - prev.x0) < line.right - line.left && pitch > 1.6 * page.pitch;
        fresh = !hyphen && (sized || indented || jumped || fits(prev, line));
      }
      if (fresh) {
        // A footnote waits until the paragraph the page ends in is complete.
        if (line.note) {
          if (flow.current) heldNotes.push(flow.current);
        } else closeBody();
        flow.current = { lines: [], page: line.p, note: !!line.note };
      }
      flow.current.lines.push(line);
      flow.prev = line;
    }
  closeBody();

  // 5. Hyphens at line ends, decided with the book's own vocabulary.
  const vocabulary = new Set(), compounds = new Set();
  for (const paragraph of paragraphs)
    for (const line of paragraph.lines) {
      const broken = /\p{L}[-­¬]$/u.test(line.text);
      line.words.forEach((word, i) => {
        if (broken && i === line.words.length - 1) return;
        for (const compound of word.t.toLowerCase().match(/\p{L}+(?:-\p{L}+)+/gu) || []) compounds.add(compound);
        for (const part of word.t.toLowerCase().match(/\p{L}+/gu) || []) vocabulary.add(part);
      });
    }
  const hyphens = [];
  const joinLines = (lines) => {
    let text = "";
    for (const line of lines) {
      if (!text) {
        text = line.text;
        continue;
      }
      const tail = /(\p{L}+)([-­¬])$/u.exec(text), head = /^(\p{L}+)/u.exec(line.text);
      if (!tail || !head) {
        text += " " + line.text;
        continue;
      }
      const [a, b] = [tail[1], head[1]], joined = (a + b).toLowerCase();
      let decision;
      if (tail[2] !== "-") decision = "join";
      else if (/^\p{Lu}/u.test(b)) decision = "keep";
      else if (vocabulary.has(joined)) decision = "join";
      else if (compounds.has(`${a}-${b}`.toLowerCase())) decision = "keep";
      else if (a.length >= 3 && b.length >= 3 && vocabulary.has(a.toLowerCase()) && vocabulary.has(b.toLowerCase())) decision = "keep-guess";
      else decision = "join-guess";
      hyphens.push({ a, b, decision });
      text = decision.startsWith("join") ? text.slice(0, -1) + line.text : text + line.text;
    }
    return text;
  };

  // 6. Sentences, as extractBook cuts them. Two section schemes: the outline's pages, and one section per page.
  const sectionStarts = [...new Set(outline.map((item) => item.page))].sort((a, b) => a - b);
  const sectionOf = (page) => {
    let section = 0;
    while (section < sectionStarts.length && sectionStarts[section] <= page) section++;
    return section;
  };
  const sentences = [];
  const counters = { outline: new Map(), page: new Map() };
  const nextId = (kind, section) => {
    const n = counters[kind].get(section) || 0;
    counters[kind].set(section, n + 1);
    return `${section}:${n}`;
  };
  paragraphs.forEach((paragraph, blockIndex) => {
    const value = normalizeReaderText(joinLines(paragraph.lines));
    for (const part of segmenter.segment(value)) {
      const text = part.segment.trim();
      if (!text) continue;
      sentences.push({ id: nextId("outline", sectionOf(paragraph.page)), pageId: nextId("page", paragraph.page), text, blockIndex, page: paragraph.page, note: paragraph.note });
    }
  });

  // 7. Measures for the gate.
  const body = sentences.filter((sentence) => !sentence.note);
  const tokens = body.flatMap((sentence) => sentence.text.split(" "));
  const wordy = tokens.map((token) => token.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")).filter(Boolean);
  const known = (word) => dictionary.has(word) || dictionary.has(word.replace(/['’]s$/, "")) || word.split(/[-—–'’]/).every((part) => !part || dictionary.has(part));
  const sentenceWords = body.map((sentence) => sentence.text.split(" ").length);
  const stats = {
    furnitureLines: removedLines.size,
    shortZoneLinesKept: keptZone.length,
    rotatedLines: rotated,
    dropCaps,
    multiColumnShare: +(multiColumnPages / (textPages || 1)).toFixed(3),
    footnoteLines,
    paragraphs: paragraphs.length,
    sentences: sentences.length,
    medianSentenceWords: median(sentenceWords),
    shortSentenceShare: +(sentenceWords.filter((n) => n < 4).length / (body.length || 1)).toFixed(3),
    terminalShare: +(body.filter((sentence) => terminal(sentence.text)).length / (body.length || 1)).toFixed(3),
    lowerStartShare: +(body.filter((sentence) => /^\p{Ll}/u.test(sentence.text)).length / (body.length || 1)).toFixed(3),
    letterTokenShare: +(tokens.filter((token) => /^[("'“‘[]*\p{L}[\p{L}'’-]*[)"'”’\].,;:!?…—-]*$/u.test(token)).length / (tokens.length || 1)).toFixed(3),
    dictionaryShare: dictionary ? +(wordy.filter(known).length / (wordy.length || 1)).toFixed(3) : null,
    hyphenJoins: hyphens.filter((item) => item.decision.startsWith("join")).length,
    hyphenKept: hyphens.filter((item) => item.decision.startsWith("keep")).length,
    sections: counters.outline.size,
    buildMs: Math.round(performance.now() - t0),
  };
  fs.writeFileSync(path.join(dir, `${order}.book.json`), JSON.stringify(sentences));
  fs.writeFileSync(path.join(dir, `${order}.first200.txt`), sentences.slice(0, 200).map((s) => `${s.id}\tp${s.page + 1}${s.note ? " note" : ""}\t${s.text}`).join("\n"));
  fs.writeFileSync(
    path.join(dir, `${order}.removed.txt`),
    [...removedCount].sort((a, b) => b[1] - a[1]).map(([label, count]) => `${count}\t${label}`).join("\n") +
      "\n--- short lines kept in the zones ---\n" +
      keptZone.slice(0, 400).map((item) => `p${item.p + 1}\t${item.zone}\t${item.line.text}`).join("\n"),
  );
  fs.writeFileSync(path.join(dir, `${order}.hyphens.txt`), hyphens.map((item) => `${item.decision}\t${item.a}-${item.b}`).join("\n"));
  return stats;
}

const parseMs = Math.round(performance.now() - started);
const stats = {
  pages: parsed.length,
  textPages,
  textPageShare: +(textPages / (parsed.length || 1)).toFixed(3),
  wordsPerTextPage: median(pageWords.filter((_, i) => pageLetters[i] >= 50)),
  multiLineBlockShare: +(parsed.multiLineBlocks / (parsed.blocks || 1)).toFixed(3),
  orderAgreement: +(orderScores.reduce((a, b) => a + b, 0) / (orderScores.length || 1)).toFixed(3),
  orderBadPageShare: +(orderScores.filter((score) => score < 0.9).length / (orderScores.length || 1)).toFixed(3),
  rawUnmatchedShare: +(rawUnmatched / (rawWords || 1)).toFixed(4),
  outlineEntries: outline.length,
  parseMs,
  layout: build("layout", layoutPages),
  raw: build("raw", rawPages),
  geo: build("geo", geoPages),
};
stats.totalMs = Math.round(performance.now() - started);
stats.peakMb = Math.round(process.resourceUsage().maxRSS / 1024);
fs.writeFileSync(path.join(dir, "stats.json"), JSON.stringify(stats, null, 1));
console.log(path.basename(dir), JSON.stringify(stats));
