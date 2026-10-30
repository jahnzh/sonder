import {test} from "node:test";
import assert from "node:assert/strict";
import {readerWords,readerSegment} from "../src/reader-segments.ts";
import {appearanceSchema} from "../src/appearance.ts";
import type {ReaderBook} from "../src/reading-types.ts";
const book={sections:[{index:0,paragraphs:[{id:"one",text:"one two three four five six"},{id:"two",text:"seven eight nine ten eleven twelve"}]}]} as ReaderBook;
test("segment windows follow the current sentence and estimated word position while respecting the chosen word count",()=>{
 const words=readerWords(book);
 assert.equal(readerSegment(words,"one",4,0).words.map(w=>w.text).join(" "),"one two three four");
 assert.equal(readerSegment(words,"one",4,.9).words.map(w=>w.text).join(" "),"five six seven eight");
 assert.equal(readerSegment(words,"two",4,.9).words.map(w=>w.text).join(" "),"nine ten eleven twelve");
 assert.equal(readerSegment(words,"two",1,.5).words[0].text,"ten");
 assert.equal(readerSegment(words,"two",4,0,0).words[0].text,"one");
 assert.deepEqual(readerSegment([],undefined,30).words,[]);
});
test("older reader preferences retain full-book mode and customizable segment length validates",()=>{
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
