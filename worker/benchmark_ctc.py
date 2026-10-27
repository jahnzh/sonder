"""One-shot CPU comparison; model downloads are cached on the media drive."""
import os, json, time, resource, subprocess
from pathlib import Path
import torch
from ctc_forced_aligner import load_alignment_model, load_audio, generate_emissions, preprocess_text, get_alignments, get_spans, postprocess_results
torch.set_num_threads(2)
root=Path(os.environ['MEDIA_ROOT'])
folder=root/'alignment'/'benchmarks'
fragments=json.loads((folder/'alice-fragments.json').read_text())
mapping=json.loads((folder/'alice-aeneas.json').read_text())
end=min(120, mapping['intervals'][9]['end'])
chosen=[fragment for fragment,interval in zip(fragments,mapping['intervals']) if interval['end']<=end]
sample=folder/'alice-ctc-sample.wav'
subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(root/'demo'/'alice-01.mp3'),'-t',str(end),'-ac','1','-ar','16000','-y',str(sample)],check=True)
started=time.monotonic()
model,tokenizer=load_alignment_model('cpu',dtype=torch.float32)
loaded=time.monotonic()
audio=load_audio(str(sample),dtype=torch.float32,device='cpu')
emissions,stride=generate_emissions(model,audio,batch_size=1)
tokens,starred=preprocess_text(' '.join(chosen),romanize=True,language='eng')
segments,scores,blank=get_alignments(emissions,tokens,tokenizer)
spans=get_spans(tokens,segments,blank)
timings=postprocess_results(starred,spans,stride,scores)
result={'engine':'ctc-mms-300m','audioSeconds':end,'modelLoadSeconds':loaded-started,'processingSeconds':time.monotonic()-loaded,'peakMemoryMB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,'words':len(timings)}
(folder/'alice-ctc-timings.json').write_text(json.dumps(timings,indent=2))
(folder/'alice-ctc-metrics.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result),flush=True)
