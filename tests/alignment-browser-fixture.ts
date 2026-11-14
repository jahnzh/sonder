export function installAlignmentFixture(){
 process.env.ALIGNMENT_WORKER_URL='http://alignment-browser.test';
 // The fixture models the local aeneas worker; CTC jobs go to the remote pool, which the browser server does not run.
 process.env.ALIGNMENT_CHAPTER_ENGINE='aeneas';
 // Keep ebook-set probing on Whisper until #279 updates the fixture for CTC.
 process.env.EBOOK_SET_PROBER='whisper';
 process.env.ALIGNMENT_WORKER_TOKEN='browser-fixture-token';const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{if(!String(input).startsWith('http://alignment-browser.test/'))return original(input,init);const body=JSON.parse(String(init?.body));
  // Speech samples: a narration that starts at 5 s and reads one sentence every 8 s.
  if(String(input).endsWith('/anchor')){const index=Math.max(0,Math.ceil((body.start-5)/8));if(index>=body.fragments.length||5+index*8>body.start+body.duration-3)return Response.json({match:null,start:body.start,text:''});return Response.json({match:{index,score:.9,text:body.fragments[index]},start:5+index*8,text:body.fragments[index]});}
  return Response.json({engine:body.engine==='ctc'?'ctc-wav2vec2-base-960h-torchaudio-2.8-v2':'aeneas-1.7.3',elapsedSeconds:.1,intervals:body.fragments.map((_:string,index:number)=>({index,start:body.start+index*2,end:body.start+(index+1)*2}))});};
}
