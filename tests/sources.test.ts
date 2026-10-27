import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSearchPage as libgen,
  parseMirrorPage,
} from "../server/sources/libgen-parse.ts";
test("Library Genesis table parsing retains distinct files and resolves keyed download links", () => {
  const md5 = "c".repeat(32);
  const html = `<table id="tablelibgen"><tr><td><a>A test title</a><font>978-1234567890</font></td><td>Ada Author; Bee Writer</td><td>A publisher</td><td>2020, 2025</td><td>English</td><td>200</td><td>514 kB</td><td>EPUB</td><td><a href="ads.php?md5=${md5}">Mirror</a></td></tr></table>`;
  const files = libgen(html);
  assert.equal(files.length, 1);
  assert.equal(files[0].md5, md5);
  assert.deepEqual(files[0].authors, ["Ada Author", "Bee Writer"]);
  assert.equal(files[0].extension, "epub");
  assert.equal(files[0].year, "2020");
  assert.equal(files[0].size, "514 kB");
  assert.equal(
    parseMirrorPage(`<a href="get.php?md5=${md5}&amp;key=short">GET</a>`)
      .download,
    `get.php?md5=${md5}&key=short`,
  );
});
