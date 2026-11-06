"""The alignment and speech-recovery steps, run so that a deadline can end them. No fastapi or aeneas import."""
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path
from deadline import AlignmentFailed, alignment_limit, anchor_limit, run_with_deadline

CHILD = [sys.executable, str(Path(__file__).with_name("align_task.py"))]
ENGINE = "aeneas-1.7.3"

def _run_child(mode, spec, folder, deadline, limit, child):
    work = Path(tempfile.mkdtemp(prefix=".task-", dir=folder))
    try:
        spec_path, result_path = work / "spec.json", work / "result.json"
        spec_path.write_text(json.dumps({**spec, "mode": mode}))
        code, error = run_with_deadline([*child, str(spec_path), str(result_path)], deadline, limit)
        if code != 0 or not result_path.is_file():
            raise AlignmentFailed(error or f"alignment step exited with {code}")
        return json.loads(result_path.read_text())
    finally:
        shutil.rmtree(work, ignore_errors=True)

def align_section(*, audio, output, fragments, language, start, duration, media_folder, env=None, ffmpeg="ffmpeg", child=CHILD):
    """Extract the audio window and align it. Raises AlignmentTimeout past the scaled limit, AlignmentFailed otherwise."""
    limit = alignment_limit(duration, env)
    started = time.monotonic()
    deadline = started + limit
    output.parent.mkdir(parents=True, exist_ok=True)
    text_path, wave_path, map_path = (output.with_suffix(suffix) for suffix in (".txt", ".wav", ".aeneas.json"))
    try:
        text_path.write_text("\n".join(fragment.replace("\n", " ") for fragment in fragments))
        code, error = run_with_deadline([ffmpeg, "-nostdin", "-v", "error", "-threads", "1", "-ss", str(start), "-i", str(audio), "-t", str(duration), "-ac", "1", "-ar", "16000", "-y", str(wave_path)], deadline, limit)
        if code != 0:
            raise AlignmentFailed(error or f"ffmpeg exited with {code}")
        extracted = time.monotonic()
        step = _run_child("align", {"audio": str(audio), "wave": str(wave_path), "text": str(text_path), "map": str(map_path), "folder": str(media_folder),
                                    "fragments": fragments, "language": language, "start": start, "duration": duration}, output.parent, deadline, limit, child)
        finished = time.monotonic()
        mapped = len({item["index"] for item in step["intervals"] if 0 <= item["index"] < len(fragments) and item["end"] > item["start"]})
        outcome = "mapped" if mapped == len(fragments) else "partial" if mapped else "unsynced"
        result = {"engine": ENGINE, "outcome": outcome,
                  "stageTimings": {"audioExtraction": extracted - started, "alignment": finished - extracted},
                  "elapsedSeconds": finished - started, "peakMemoryMB": step["peakMemoryMB"], "intervals": step["intervals"], "quality": step["quality"]}
        temporary = output.with_suffix(".part")
        temporary.write_text(json.dumps(result))
        temporary.replace(output)
        return result
    finally:
        for path in (wave_path, text_path, map_path, output.with_suffix(".part")):
            path.unlink(missing_ok=True)

def locate_passage(*, audio, folder, fragments, language, start, duration, env=None, child=CHILD):
    """Transcribe a short excerpt and find it in the supplied text, under the /anchor limit."""
    limit = anchor_limit(duration, env)
    started = time.monotonic()
    try:
        result = _run_child("anchor", {"audio": str(audio), "folder": str(folder), "fragments": fragments, "language": language, "start": start, "duration": duration},
                            folder, started + limit, limit, child)
        return {**result, "engine": ENGINE, "outcome": "mapped" if result.get("match") else "unsynced",
                "stageTimings": {"speechRecovery": time.monotonic() - started}}
    finally:
        # The child writes its sample here and a SIGKILL skips its own cleanup. One job runs at a time, so any
        # sample left in the folder is dead.
        for sample in folder.glob("anchor-sample*.wav"):
            sample.unlink(missing_ok=True)
