// The reader's EPUB fixture (tests/reader-fixture.ts): each call is a file of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readerFixture } from "./reader-fixture.ts";

const hash = (data: Buffer) => createHash("md5").update(data).digest("hex");

test("two fixtures made in the same moment are different files, so two tests never share an uploaded edition (#840)", async () => {
  // An uploaded edition's id is the hash of its bytes (server/ebooks.ts). Made back to back, these share every
  // timestamp a zip can hold.
  const made = await Promise.all(Array.from({ length: 20 }, () => readerFixture()));
  assert.equal(new Set(made.map(hash)).size, made.length);
  const titled = await Promise.all([readerFixture({ title: "Same title" }), readerFixture({ title: "Same title" })]);
  assert.notEqual(hash(titled[0]), hash(titled[1]));
  // The same buffer is the same file: what a test uses when it means to upload one book twice.
  assert.equal(hash(made[0]), hash(Buffer.from(made[0])));
});
