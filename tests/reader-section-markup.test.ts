// epub.js parses a document named .html as HTML, where a self-closing <title/> swallows the rest of the page (#812).
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeRawTextElements } from "../src/reader-section-markup.ts";

test("a self-closing title gets an end tag", () => {
  assert.equal(closeRawTextElements("<head><title/><meta name='a'/></head>"), "<head><title></title><meta name='a'/></head>");
  assert.equal(closeRawTextElements("<head><title /></head>"), "<head><title ></title></head>");
  assert.equal(closeRawTextElements("<HEAD><TITLE/></HEAD>"), "<HEAD><TITLE></TITLE></HEAD>");
});

test("the other elements whose content HTML reads as text get one too, with their attributes", () => {
  assert.equal(closeRawTextElements('<style type="text/css"/><p>x</p>'), '<style type="text/css"></style><p>x</p>');
  for (const name of ["textarea", "script", "iframe", "noscript", "noframes", "noembed", "xmp"])
    assert.equal(closeRawTextElements(`<${name}/><p>x</p>`), `<${name}></${name}><p>x</p>`);
});

test("everything else stays as it is written", () => {
  for (const markup of [
    '<p class="p0"><a id="a4"/> </p><br/><img src="a.png"/><div/>',
    "<head><title>Chapter 1</title></head>",
    "<head><title></title></head>",
    "<titles/><p>x</p>",
  ])
    assert.equal(closeRawTextElements(markup), markup);
});
