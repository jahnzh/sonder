import {test} from "node:test";
import assert from "node:assert/strict";
import {readerWords} from "../src/reader-segments.ts";
import {appearanceSchema} from "../src/appearance.ts";
import type {ReaderBook} from "../src/reading-types.ts";
const book={sections:[{index:0,paragraphs:[{id:"one",text:" one  two three "},{id:"two",text:"four"}]},{index:2,paragraphs:[{id:"three",text:"five six"},{id:"empty",text:"  "}]}]} as ReaderBook;
test("the word list holds every word of the book in order, each with its sentence and section",()=>{
 assert.deepEqual(readerWords(book),[
  {text:"one",paragraphId:"one",section:0},{text:"two",paragraphId:"one",section:0},{text:"three",paragraphId:"one",section:0},
  {text:"four",paragraphId:"two",section:0},{text:"five",paragraphId:"three",section:2},{text:"six",paragraphId:"three",section:2},
 ]);
});
// The view choice, words per line and words per minute are no longer used, but older clients still send them (ADR 0017).
test("older reader preferences with the removed view fields still parse, with their old defaults and limits",()=>{
 const reader=appearanceSchema.parse({reader:{mode:"scroll"}}).reader;
 assert.equal(reader.display,"book");assert.equal(reader.segmentWords,30);
 assert.equal(reader.wordWpm,300);
 assert.equal(appearanceSchema.parse({reader:{display:"segment",segmentWords:1}}).reader.segmentWords,1);
 assert.equal(appearanceSchema.parse({reader:{display:"word",wordWpm:450}}).reader.display,"word");
 assert.equal(appearanceSchema.parse({reader:{display:"word"}}).reader.wordWpm,300);
 assert.equal(appearanceSchema.safeParse({reader:{segmentWords:0}}).success,false);
 assert.equal(appearanceSchema.safeParse({reader:{segmentWords:4.5}}).success,false);
 assert.equal(appearanceSchema.safeParse({reader:{wordWpm:99}}).success,false);
 assert.equal(appearanceSchema.safeParse({reader:{wordWpm:901}}).success,false);
});
