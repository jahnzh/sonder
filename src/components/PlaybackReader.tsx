import { isAdmin } from "../lib";
import { userStorageKey } from "../lib";
import { useEffect, useState } from "react";
import { api, localDB } from "../lib";
import { ReaderView } from "./Reader";
import {PlaybackExtra} from "./PlaybackMenu";
import type { Book, SavedEbook } from "../types";
import type { AlignmentJob } from "../reading-types";
export function PlaybackReader({book,books,notify,onAvailable,onMissing,onClose}:{book:Book;books:Book[];notify:(text:string,error?:boolean)=>void;onAvailable:(available:boolean)=>void;onMissing:()=>void;onClose:()=>void}) {
  const [ebooks,setEbooks]=useState<SavedEbook[]>([]),[selected,setSelected]=useState(""),[loading,setLoading]=useState(true);
  useEffect(()=>{
    let live=true;
    setLoading(true);setEbooks([]);setSelected("");onAvailable(false);
    void (async()=>{
      const all=await api<SavedEbook[]>("/ebooks").then(async value=>{await localDB.preferences.put({key:"ebooks",value});return value;}).catch(async()=>((await localDB.preferences.get("ebooks"))?.value || []) as SavedEbook[]);
      const editions=all.filter(ebook=>ebook.workId===book.workId && ebook.format==="epub" && ebook.available);
      const preferred=editions.find(ebook=>ebook.id===localStorage.getItem(userStorageKey(`reader-ebook:${book.workId}`)));
      let chosen=preferred;
      if(!chosen && editions.length>1) {
        const maps=await Promise.all(editions.map(async ebook=>{
          const data=await api<{jobs:AlignmentJob[]}>(`/alignments?ebookId=${encodeURIComponent(ebook.id)}&summary=1`).catch(()=>null);
          return data?.jobs.some(job=>job.recordingId===book.recordingId && (job.intervalCount ?? job.intervals.length) > 0) ? ebook : null;
        }));
        chosen=maps.find(ebook=>!!ebook) || undefined;
      }
      if(!live)return;
      setEbooks(editions);setSelected((chosen || editions[0])?.id || "");setLoading(false);onAvailable(!!editions.length);
    })().catch(()=>{if(live)setLoading(false);});
    const choose=(event:Event)=>{
      const detail=(event as CustomEvent).detail;
      if(detail.workId===book.workId){setSelected(detail.id);localStorage.setItem(userStorageKey(`reader-ebook:${book.workId}`),detail.id);}
    };
    window.addEventListener("sonder:playback-reader",choose);
    return ()=>{live=false;window.removeEventListener("sonder:playback-reader",choose);};
  },[book.workId]);
  return <section className={`playback-reader ${selected ? "has-ebook" : ""}`} aria-label="Playback ebook">
    {loading ? <p role="status">Loading ebook…</p> : selected ? <>
      {ebooks.length>1 && <PlaybackExtra><label className="playback-ebook-edition">Ebook edition<select aria-label="Playback ebook edition" value={selected} onChange={event=>{setSelected(event.target.value);localStorage.setItem(userStorageKey(`reader-ebook:${book.workId}`),event.target.value);}}>{ebooks.map((ebook,index)=><option key={ebook.id} value={ebook.id}>{ebook.title} · {ebook.id.startsWith("upload-") ? "Imported EPUB" : `EPUB ${index+1}`}</option>)}</select></label></PlaybackExtra>}
      <ReaderView key={selected} id={selected} fromAudio={false} inline recordingId={book.recordingId} books={books} notify={notify} onClose={onClose}/>
    </> : isAdmin() ? <button className="button subtle" onClick={onMissing}>Find ebook</button> : null}
  </section>;
}
