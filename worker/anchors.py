"""Short, local speech excerpts for locating supplied ebook text, never whole-book ASR."""
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

_model = None
MODEL_REVISION = "d90ca5fe260221311c53c58e660288d3deb8d356"

def words(text):
    return re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).lower(), re.UNICODE)

def match_excerpt(text, fragments):
    query = words(text)
    corpus, owners = [], []
    for index, fragment in enumerate(fragments):
        tokens = words(fragment)
        corpus.extend(tokens)
        owners.extend([index] * len(tokens))
    if len(query) < 6 or not corpus:
        return None
    blocks = SequenceMatcher(None, query, corpus, autojunk=False).get_matching_blocks()
    candidates = {max(0, block.b - block.a) for block in blocks if block.size >= 3}
    best = None
    for start in candidates:
        end = min(len(corpus), start + len(query))
        score = SequenceMatcher(None, query, corpus[start:end], autojunk=False).ratio()
        if best is None or score > best['score']:
            best = {"index": owners[start], "lastIndex": owners[end - 1], "score": round(score, 3), "text": text}
    return best if best and best['score'] >= 0.5 else None

def transcribe_excerpt(audio, folder, start, duration, language):
    import subprocess
    from faster_whisper import WhisperModel
    global _model
    if _model is None:
        _model = WhisperModel("tiny", device="cpu", compute_type="int8", cpu_threads=2,
                              download_root=str(folder / "models" / "whisper"), local_files_only=True, revision=MODEL_REVISION)
    sample = folder / "anchor-sample.wav"
    try:
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(start), "-i", str(audio),
                        "-t", str(duration), "-ac", "1", "-ar", "16000", "-y", str(sample)],
                       check=True, timeout=90, capture_output=True)
        short_language = {"eng":"en", "fra":"fr", "deu":"de", "spa":"es", "ita":"it", "por":"pt", "nob":"no", "dan":"da", "swe":"sv", "nld":"nl"}.get(language)
        segments, _ = _model.transcribe(str(sample), language=short_language, beam_size=1,
                                       condition_on_previous_text=False, word_timestamps=True)
        result = []
        for segment in segments:
            result.extend({"text": w.word, "start": w.start + start, "end": w.end + start} for w in (segment.words or []))
        return result
    finally:
        sample.unlink(missing_ok=True)

def locate_excerpt(audio, folder, fragments, start, duration, language):
    spoken = transcribe_excerpt(audio, folder, start, duration, language)
    text = " ".join(word['text'].strip() for word in spoken)
    result = match_excerpt(text, fragments)
    return {"match": result, "start": spoken[0]['start'] if spoken else start,
            "end": spoken[-1]['end'] if spoken else start + duration, "text": text}
