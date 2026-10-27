import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = await readdir("dist", { recursive: true });
const assets = files
  .filter(
    (f) =>
      /\.(js|css|html|svg|png|webmanifest|woff2)$/.test(f) && f !== "sw.js",
  )
  .map((f) => "/" + f);
const version = createHash("sha256")
  .update(await readFile("dist/index.html"))
  .digest("hex")
  .slice(0, 12);
let sw = await readFile("public/sw.js", "utf8");
sw = sw
  .replace("/* PRECACHE */ []", JSON.stringify(assets))
  .replace('/* VERSION */ "dev"', JSON.stringify(version));
await writeFile("dist/sw.js", sw);
console.log(`Offline shell: ${assets.length} assets · ${version}`);
