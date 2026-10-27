export function installAlignmentFixture(){
 process.env.ALIGNMENT_WORKER_URL='http://alignment-browser.test';process.env.ALIGNMENT_WORKER_TOKEN='browser-fixture-token';const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{if(!String(input).startsWith('http://alignment-browser.test/'))return original(input,init);const body=JSON.parse(String(init?.body));return Response.json({engine:'aeneas-1.7.3',elapsedSeconds:.1,intervals:body.fragments.map((_:string,index:number)=>({index,start:body.start+index*2,end:body.start+(index+1)*2}))});};
}
