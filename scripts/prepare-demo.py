import urllib.request,json,concurrent.futures,re,os
from urllib.parse import urlencode,quote
ids={'alice':'alice_in_wonderland_librivox','sherlock':'the_adventures_of_sherlock_holmes_v5_1904_librivox','pride':'solo_pride_librivox','frankenstein':'frankenstein1831_tac_librivox','time':'thetimemachineversion_7_2105_librivox','gatsby':'great_gatsby_2305_librivox','war':'art_war_ps_librivox','meditations':'meditations_0708_librivox'}
def length(v):
 try:
  parts=str(v).split(':');n=0
  for p in parts:n=n*60+float(p)
  return n
 except:return 0
def get(pair):
 key,ident=pair
 try:
  meta=json.load(urllib.request.urlopen('https://archive.org/metadata/'+ident,timeout=45))
  files=[f for f in meta.get('files',[]) if f.get('name','').endswith('.mp3') and f.get('format') in ['64Kbps MP3','128Kbps MP3','VBR MP3']]
  # Prefer one consistent encoding, never both derivatives of the same chapter.
  fmts=[f.get('format') for f in files]
  preferred='64Kbps MP3' if '64Kbps MP3' in fmts else '128Kbps MP3' if '128Kbps MP3' in fmts else 'VBR MP3'
  files=sorted([f for f in files if f.get('format')==preferred],key=lambda f:f['name'])
  result=[{'title':f.get('title') or 'Chapter '+str(i+1),'duration':length(f.get('length',0)),'url':'https://archive.org/download/'+ident+'/'+quote(f['name'])} for i,f in enumerate(files)]
  print(key,len(result),meta.get('metadata',{}).get('creator'),flush=True)
  return key,result
 except Exception as e:
  print(key,str(e),flush=True);return key,[]
results=dict(concurrent.futures.ThreadPoolExecutor().map(get,ids.items()))
with open('server/catalog.json','w') as f:json.dump(results,f,indent=2)
if results.get('alice'):
 urllib.request.urlretrieve(results['alice'][0]['url'],'public/audio/alice-01.mp3')
 print('Downloaded Alice chapter one',os.path.getsize('public/audio/alice-01.mp3'),flush=True)
