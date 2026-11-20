#!/usr/bin/env bash
# Memory and speed of one server configuration: start it, read the GPU memory it took, time one long prompt, stop it.
#   probe.sh <model.gguf> <ctx> [prompt tokens, default 6000]
# Environment as for serve.sh: RECAP_NGL, RECAP_KV. Prints one JSON line.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/env.sh"
model="$1"; ctx="$2"; prompt="${3:-6000}"
gpu() { nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits; }
baseline="$(gpu)"
log="$(mktemp "$RECAP_HOME/logs/probe.XXXXXX.log")"
"$here/serve.sh" "$model" "$ctx" -lv 4 > "$log" 2>&1 &
trap '"$here/stop.sh" > /dev/null || true' EXIT
for _ in $(seq 1 180); do curl -sf -m 2 "http://127.0.0.1:$RECAP_PORT/health" > /dev/null && break; sleep 1; done
curl -sf -m 2 "http://127.0.0.1:$RECAP_PORT/health" > /dev/null || { echo "{\"model\": \"$model\", \"ctx\": $ctx, \"error\": \"did not start\", \"log\": \"$log\"}"; exit 1; }
loaded="$(gpu)"
python3 - "$RECAP_HOME/work/books/fixture.json" "$RECAP_PORT" "$prompt" "$model" "$ctx" "$baseline" "$loaded" "${RECAP_NGL:-all}" "${RECAP_KV:-q8_0}" <<'PY'
import json, subprocess, sys, urllib.request
book, port, want, model, ctx, baseline, loaded, ngl, kv = sys.argv[1:]
want = int(want)
sentences = [s["text"] for s in json.load(open(book))["sentences"]]
text, n = [], 0
while sum(len(t) for t in text) / 3.4 < want:
    text.append(f"[{n // len(sentences)}:{n % len(sentences)}] {sentences[n % len(sentences)]}")
    n += 1
body = {"messages": [{"role": "user", "content": "\n".join(text) + "\n\nSummarise the story above in about 180 words."}], "max_tokens": 256, "temperature": 0.2, "cache_prompt": False}
request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", json.dumps(body).encode(), {"content-type": "application/json"})
timings = json.load(urllib.request.urlopen(request, timeout=600))["timings"]
peak = int(subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"]).decode().strip())
print(json.dumps({"model": model, "ctx": int(ctx), "gpuLayers": ngl, "kvCache": kv, "baselineMiB": int(baseline), "loadedMiB": int(loaded), "afterPromptMiB": peak, "tookMiB": peak - int(baseline),
                  "promptTokens": timings["prompt_n"], "promptPerSecond": round(timings["prompt_per_second"]), "outputTokens": timings["predicted_n"], "outputPerSecond": round(timings["predicted_per_second"], 1)}))
PY
