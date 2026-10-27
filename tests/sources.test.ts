import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchPage as anna } from "../server/sources/annas-archive-parse.ts";
import {
  parseSearchPage as libgen,
  parseMirrorPage,
} from "../server/sources/libgen-parse.ts";
test("Anna’s Archive results retain edition identity, format, language and author", () => {
  const md5 = "a".repeat(32);
  const files = anna(
    `<section><article><img src="/cover.jpg"/><a class="js-vim-focus" href="/md5/${md5}">A test title</a><a><span class="user-edit">Ada Author</span></a><div>English [en] · EPUB · 0.5MB · 2021 · Book</div></article><article><a class="js-vim-focus" href="/md5/${"b".repeat(32)}">Another title</a></article></section>`,
    "https://annas-archive.gl",
  );
  assert.equal(files[0].md5, md5);
  assert.equal(files[0].title, "A test title");
  assert.deepEqual(files[0].authors, ["Ada Author"]);
  assert.equal(files[0].extension, "epub");
  assert.equal(files[0].language, "English");
  assert.equal(files[0].coverUrl, "https://annas-archive.gl/cover.jpg");
});
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
