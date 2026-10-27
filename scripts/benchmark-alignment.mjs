// Run only against local media. The worker token is never printed.
import fs from 'node:fs';
import path from 'node:path';
process.loadEnvFile('.env');
const [textFile,audioFile,seconds='640']=process.argv.slice(2);
if(!textFile||!audioFile)throw new Error('Usage: node scripts/benchmark-alignment.mjs fragments.json audio.mp3 [seconds]');
const fragments=JSON.parse(fs.readFileSync(textFile,'utf8'));
const output=path.join(process.env.MEDIA_ROOT,'alignment','benchmarks',`sample-${Date.now()}.json`);
const started=performance.now();
const response=await fetch(process.env.ALIGNMENT_WORKER_URL+'/align',{
 method:'POST',headers:{'content-type':'application/json'},
 body:JSON.stringify({token:process.env.ALIGNMENT_WORKER_TOKEN,audio:path.resolve(audioFile),output,fragments,language:'eng',start:0,duration:Number(seconds)}),
 signal:AbortSignal.timeout(1800000),
});
const result=await response.json();
if(!response.ok)throw new Error(`Local benchmark failed (${response.status})`);
console.log(JSON.stringify({audioSeconds:Number(seconds),wallSeconds:(performance.now()-started)/1000,workerSeconds:result.elapsedSeconds,peakMemoryMB:result.peakMemoryMB,intervals:result.intervals.length,speechMatchScore:result.quality?.match?.score,output},null,2));
