"""Local known-text alignment. This service never downloads or uploads audio."""
import json
import os
import secrets
import subprocess
import time
from pathlib import Path
from threading import Lock
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI()
lock = Lock()
root = Path(os.environ.get("MEDIA_ROOT", "/mnt/usb_4t_1/sonder")).resolve()

class AlignRequest(BaseModel):
    token: str
    audio: str
    output: str
    fragments: list[str] = Field(min_length=1, max_length=20000)
    language: str = "eng"
    start: float = Field(default=0, ge=0)
    duration: float = Field(gt=0, le=7200)

class AnchorRequest(AlignRequest):
    duration: float = Field(gt=0, le=60)

@app.post("/anchor")
def anchor(request: AnchorRequest):
    token = os.environ.get("ALIGNMENT_WORKER_TOKEN", "")
    if not token or not secrets.compare_digest(request.token, token):
        raise HTTPException(401, "Worker authentication required.")
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "The local alignment worker is busy.")
    try:
        expected = os.environ.get("MEDIA_VOLUME_ID")
        marker = root / ".media-volume"
        if expected and (not marker.is_file() or marker.read_text().strip() != expected):
            raise HTTPException(503, "The media drive is unavailable.")
        from anchors import locate_excerpt
        result = locate_excerpt(checked_path(request.audio, True), root / "alignment", request.fragments,
                                request.start, request.duration, request.language)
        return result
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, "Local speech recovery is unavailable. Check that the tiny model is installed on the media drive.")
    finally:
        lock.release()

def checked_path(value: str, must_exist=False):
    path = Path(value).resolve()
    if not path.is_relative_to(root) or (must_exist and not path.is_file()):
        raise HTTPException(400, "The audio must be on the configured media drive.")
    return path

@app.get("/health")
def health():
    return {"ready": True, "engine": "aeneas-1.7.3", "busy": lock.locked()}

@app.post("/align")
def align(request: AlignRequest):
    token = os.environ.get("ALIGNMENT_WORKER_TOKEN", "")
    if not token or not secrets.compare_digest(request.token, token):
        raise HTTPException(401, "Worker authentication required.")
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "The local alignment worker is busy.")
    try:
        marker = root / ".media-volume"
        expected = os.environ.get("MEDIA_VOLUME_ID")
        if expected and (not marker.is_file() or marker.read_text().strip() != expected):
            raise HTTPException(503, "The media drive is unavailable.")
        audio = checked_path(request.audio, True)
        output = checked_path(request.output)
        if not output.is_relative_to(root / "alignment"):
            raise HTTPException(400, "Alignment output must be in its cache directory.")
        output.parent.mkdir(parents=True, exist_ok=True)
        text_path = output.with_suffix(".txt")
        wave_path = output.with_suffix(".wav")
        map_path = output.with_suffix(".aeneas.json")
        text_path.write_text("\n".join(fragment.replace("\n", " ") for fragment in request.fragments))
        started = time.monotonic()
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-ss", str(request.start), "-i", str(audio), "-t", str(request.duration), "-ac", "1", "-ar", "16000", "-y", str(wave_path)], check=True, timeout=600, capture_output=True)
        from aeneas.task import Task
        from aeneas.executetask import ExecuteTask
        language = request.language if request.language in {"eng", "fra", "deu", "spa", "ita", "por", "nob", "dan", "swe", "nld"} else "eng"
        task = Task(config_string=f"task_language={language}|is_text_type=plain|os_task_file_format=json|task_adjust_boundary_algorithm=percent|task_adjust_boundary_percent_value=50")
        task.audio_file_path_absolute = str(wave_path)
        task.text_file_path_absolute = str(text_path)
        task.sync_map_file_path_absolute = str(map_path)
        ExecuteTask(task).execute()
        task.output_sync_map_file()
        raw = json.loads(map_path.read_text())
        intervals = [{"index": i, "start": float(fragment["begin"]) + request.start, "end": float(fragment["end"]) + request.start} for i, fragment in enumerate(raw["fragments"])]
        quality = None
        # A short independent excerpt catches gross edition mismatches. The full text
        # still goes straight to the aligner; this never transcribes the chapter.
        if (root / "alignment" / "models" / "whisper").exists():
            from anchors import locate_excerpt
            excerpt_start = request.start + max(0, request.duration / 2 - 15)
            quality = locate_excerpt(audio, root / "alignment", request.fragments, excerpt_start,
                                     min(30, request.duration), language)
            if quality['match'] is None and len(quality['text'].split()) >= 10:
                intervals = []
        import resource
        result = {"engine": "aeneas-1.7.3", "elapsedSeconds": time.monotonic() - started, "peakMemoryMB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, "intervals": intervals, "quality": quality}
        temporary = output.with_suffix(".part")
        temporary.write_text(json.dumps(result))
        temporary.replace(output)
        return result
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, "Local alignment could not match this section. Check the edition and chapter pairing.")
    finally:
        for path in (locals().get("wave_path"), locals().get("text_path"), locals().get("map_path")):
            if path and path.is_file():
                path.unlink()
        lock.release()
