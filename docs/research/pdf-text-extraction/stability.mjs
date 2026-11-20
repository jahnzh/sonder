// Compares the sentences of two extractions of the same PDFs (e.g. two poppler versions).
// Usage: node stability.mjs <out dir A> <out dir B> [layout|raw]
import fs from "node:fs"; import path from "node:path";
const [a, b, order = "layout"] = process.argv.slice(2);
for (const name of fs.readdirSync(a).sort()) {
  const read = (root) => JSON.parse(fs.readFileSync(path.join(root, name, `${order}.book.json`), "utf8"));
  if (!fs.existsSync(path.join(b, name, `${order}.book.json`))) continue;
  const [one, two] = [read(a), read(b)];
  const share = (field) => {
    const other = new Set(two.map((s) => `${s[field]}\t${s.text}`));
    return (one.filter((s) => other.has(`${s[field]}\t${s.text}`)).length / (one.length || 1)).toFixed(4);
  };
  const texts = new Set(two.map((s) => s.text));
  let first = 0;
  while (first < one.length && first < two.length && one[first].text === two[first].text) first++;
  console.log(`${name.padEnd(27)} sentences ${one.length}/${two.length} sameText ${(one.filter((s) => texts.has(s.text)).length / (one.length || 1)).toFixed(4)} sameId(outline sections) ${share("id")} sameId(page sections) ${share("pageId")} firstDifference ${first === one.length && first === two.length ? "none" : first}`);
}
