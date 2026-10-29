"""Local known-text alignment. This service never downloads or uploads audio."""
import os
import secrets
import sys
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from deadline import AlignmentTimeout, Gate, WorkerBusy
from pipeline import align_section, locate_passage

app = FastAPI()
gate = Gate()
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
    try:
        with gate.hold():
            expected = os.environ.get("MEDIA_VOLUME_ID")
            marker = root / ".media-volume"
            if expected and (not marker.is_file() or marker.read_text().strip() != expected):
                raise HTTPException(503, "The media drive is unavailable.")
            return locate_passage(audio=checked_path(request.audio, True), folder=root / "alignment", fragments=request.fragments,
                                  language=request.language, start=request.start, duration=request.duration)
    except WorkerBusy:
        raise HTTPException(409, "The local alignment worker is busy.")
    except AlignmentTimeout as error:
        raise HTTPException(504, str(error))
    except HTTPException:
        raise
    except Exception as error:
        print(f"[anchor] failed: {error!r}", file=sys.stderr, flush=True)
        raise HTTPException(422, "Local speech recovery is unavailable. Check that the tiny model is installed on the media drive.")

def checked_path(value: str, must_exist=False):
    path = Path(value).resolve()
    if not path.is_relative_to(root) or (must_exist and not path.is_file()):
        raise HTTPException(400, "The audio must be on the configured media drive.")
    return path

@app.get("/health")
def health():
    return {"ready": True, "engine": "aeneas-1.7.3", "busy": gate.busy, "stuck": gate.stuck, "busySeconds": gate.busy_seconds(), "lastTimeout": gate.last_timeout}

@app.post("/align")
def align(request: AlignRequest):
    token = os.environ.get("ALIGNMENT_WORKER_TOKEN", "")
    if not token or not secrets.compare_digest(request.token, token):
        raise HTTPException(401, "Worker authentication required.")
    try:
        with gate.hold():
            marker = root / ".media-volume"
            expected = os.environ.get("MEDIA_VOLUME_ID")
            if expected and (not marker.is_file() or marker.read_text().strip() != expected):
                raise HTTPException(503, "The media drive is unavailable.")
            audio = checked_path(request.audio, True)
            output = checked_path(request.output)
            if not output.is_relative_to(root / "alignment"):
                raise HTTPException(400, "Alignment output must be in its cache directory.")
            language = request.language if request.language in {"eng", "fra", "deu", "spa", "ita", "por", "nob", "dan", "swe", "nld"} else "eng"
            return align_section(audio=audio, output=output, fragments=request.fragments, language=language,
                                 start=request.start, duration=request.duration, media_folder=root / "alignment")
    except WorkerBusy:
        raise HTTPException(409, "The local alignment worker is busy.")
    except AlignmentTimeout as error:
        raise HTTPException(504, str(error))
    except HTTPException:
        raise
    except Exception as error:
        print(f"[align] failed: {error!r}", file=sys.stderr, flush=True)
        raise HTTPException(422, "Local alignment could not match this section. Check the edition and chapter pairing.")
