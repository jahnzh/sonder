import type { ReaderBook } from "./reading-types";
export type ReaderWord = { text: string; paragraphId: string; section: number };
export function readerWords(book: ReaderBook): ReaderWord[] {
  return book.sections.flatMap(section => section.paragraphs.flatMap(fragment =>
    fragment.text.trim().split(/\s+/u).filter(Boolean).map(text => ({text, paragraphId: fragment.id, section:section.index})),
  ));
}
export function readerSegment(words: ReaderWord[], paragraphId: string | undefined, count: number, fraction=0, manual: number | null=null) {
  const first=words.findIndex(word=>word.paragraphId===paragraphId);
  let length=0;
  if(first>=0) while(words[first+length]?.paragraphId===paragraphId) length++;
  const cursor=Math.max(0,Math.min(words.length-1,manual ?? (Math.max(0,first)+Math.min(Math.max(0,length-1),Math.floor(Math.max(0,Math.min(1,fraction))*length)))));
  const size=Math.max(1,Math.floor(count));
  const start=Math.floor(cursor/size)*size;
  return {words:words.slice(start,start+size),start,cursor,total:words.length};
}
