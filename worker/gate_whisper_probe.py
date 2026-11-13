"""Whisper arm of the probing gate (#278): what the current prober answers for each sample of each candidate.

Each sample's audio is transcribed once and matched against every candidate with the worker's own excerpt
matcher, which is exactly what /anchor does per request (locate_excerpt). Run it on the host that holds the
audio, next to the worker code, outside `npm test`."""
import argparse
import json
import sys
from pathlib import Path

import anchors


def locate(transcribe_words, fragments, start):
    """The /anchor answer for one sample and one candidate, given the sample's transcribed words."""
    text = " ".join(word["text"].strip() for word in transcribe_words)
    match = anchors.match_excerpt(text, fragments)
    return {"text": text, "start": transcribe_words[0]["start"] if transcribe_words else start,
            "match": {"index": match["index"], "score": match["score"]} if match else None}


def probe_title(audio, folder, samples, candidates, transcribe=None, cache=None, save=None, language="eng"):
    """Per candidate, one /anchor-style answer per sample, in sample order."""
    transcribe = transcribe or anchors.transcribe_excerpt
    cache = {} if cache is None else cache
    results = {name: [] for name in candidates}
    for sample in samples:
        key = f"{sample['time']}:{sample['duration']}"
        if key not in cache:
            cache[key] = transcribe(audio, folder, sample["time"], sample["duration"], language)
            if save:
                save(cache)
        for name, fragments in candidates.items():
            results[name].append(locate(cache[key], fragments, sample["time"]))
    return results


def write_atomic(path, value):
    temporary = path.with_suffix(".part")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True, help="directory written by `gate-ctc-probing.ts plan`")
    parser.add_argument("--media-root", required=True, help="MEDIA_ROOT holding alignment/models/whisper")
    parser.add_argument("--titles", default="", help="comma separated title keys (default: all)")
    args = parser.parse_args(argv)
    work, media = Path(args.work), Path(args.media_root).resolve()
    folder = media / "alignment"
    folder.mkdir(parents=True, exist_ok=True)
    (work / "whisper").mkdir(exist_ok=True)
    passages = {path.stem: json.loads(path.read_text())["passages"] for path in sorted((work / "passages").glob("*.json"))}
    wanted = [name for name in args.titles.split(",") if name]
    for path in sorted((work / "samples").glob("*.json")):
        plan = json.loads(path.read_text())
        if wanted and plan["title"] not in wanted:
            continue
        cache_path = work / "whisper" / f"{plan['title']}.transcripts.json"
        cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
        out = work / "whisper" / f"{plan['title']}.json"
        if out.exists():
            continue
        samples = plan["samples"]
        results = probe_title(plan["audio"], folder, samples, passages, cache=cache,
                              save=lambda value: write_atomic(cache_path, value))
        write_atomic(out, results)
        print(f"{plan['title']}: {len(samples)} samples x {len(passages)} candidates", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
