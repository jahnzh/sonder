"""Local known-text alignment. This service never downloads or uploads audio."""
import os
import importlib.util
import secrets
import sys
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from deadline import AlignmentTimeout, Gate, WorkerBusy, worker_slots
from pipeline import ENGINE, align_section, locate_passage
from ctc_acoustic import ENGINE as CTC_ENGINE, checkpoint_path
from ctc_pipeline import align_ctc_batch_locate, align_ctc_section, shutdown_locate_pool
from ctc_decode import evict_decoded
from ctc_gpu import GpuMonitor
import ctc_prefetch
from align_task import LANGUAGES

root = Path(os.environ.get("MEDIA_ROOT", "/mnt/usb_4t_1/sonder")).resolve()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Cap decoded WAVs left by prior runs before accepting work.
    try:
        evict_decoded(root / "alignment")
    except OSError:
        pass
    try:
        yield
    finally:
        # Persistent WSL/lisa workers must not retain book-sized locate indexes after stop.
        shutdown_locate_pool()
        ctc_prefetch.shutdown()


app = FastAPI(lifespan=lifespan)
gate = Gate(worker_slots())

class PrefetchWindow(BaseModel):
    audio: str
    start: float = Field(default=0, ge=0)
    duration: float = Field(gt=0, le=7200)


class AlignRequest(BaseModel):
    token: str
    audio: str
    output: str
    fragments: list[str] = Field(min_length=1, max_length=20000)
    language: str = "eng"
    start: float = Field(default=0, ge=0)
    duration: float = Field(gt=0, le=7200)
    engine: Literal["aeneas", "ctc"] = "aeneas"
    # Upcoming sections of this job: their audio is extracted in parallel while this one runs (CTC only).
    prefetch: list[PrefetchWindow] = Field(default_factory=list, max_length=16)
    recordingId: str | None = Field(default=None, max_length=512)
    audioFingerprint: str | None = Field(default=None, max_length=512)
    trackId: str | None = Field(default=None, max_length=512)
    # A microbatch an earlier out-of-memory error halved for this job (CTC only); older servers omit it.
    microbatch: int | None = Field(default=None, ge=1, le=64)

class AnchorRequest(AlignRequest):
    duration: float = Field(gt=0, le=60)

class AnchorWindow(BaseModel):
    start: float = Field(ge=0)
    duration: float = Field(gt=0, le=60)

class AnchorBatchRequest(BaseModel):
    token: str
    audio: str
    output: str
    fragments: list[str] = Field(min_length=1, max_length=20000)
    language: str = "eng"
    windows: list[AnchorWindow] = Field(min_length=1, max_length=256)
    engine: Literal["ctc"] = "ctc"
    recordingId: str | None = Field(default=None, max_length=512)
    audioFingerprint: str | None = Field(default=None, max_length=512)
    trackId: str | None = Field(default=None, max_length=512)
    microbatch: int | None = Field(default=None, ge=1, le=64)

@app.post("/anchor")
def anchor(request: AnchorRequest):
    token = os.environ.get("ALIGNMENT_WORKER_TOKEN", "")
    if not token or not secrets.compare_digest(request.token, token):
        raise HTTPException(401, "Worker authentication required.")
    started = time.monotonic()
    engine = CTC_ENGINE if request.engine == "ctc" else ENGINE
    try:
        with gate.hold():
            with GpuMonitor() as gpu:
                expected = os.environ.get("MEDIA_VOLUME_ID")
                marker = root / ".media-volume"
                if expected and (not marker.is_file() or marker.read_text().strip() != expected):
                    raise HTTPException(503, "The media drive is unavailable.")
                audio = checked_path(request.audio, True)
                if request.language not in ({"eng"} if request.engine == "ctc" else LANGUAGES):
                    return {"engine": engine, "outcome": "language_not_supported", "stageTimings": {"requestValidation": time.monotonic() - started}, "match": None, "gpuUtilization": None}
                if request.engine == "ctc":
                    output = checked_path(request.output)
                    if not output.is_relative_to(root / "alignment"):
                        raise HTTPException(400, "Alignment output must be in its cache directory.")
                    result = align_ctc_section(audio=audio, output=output, fragments=request.fragments,
                                             language=request.language, start=request.start, duration=request.duration,
                                             media_folder=root / "alignment", recording_id=request.recordingId,
                                             recording_fingerprint=request.audioFingerprint, track_id=request.trackId, locate=True,
                                             microbatch=request.microbatch)
                else:
                    result = locate_passage(audio=audio, folder=root / "alignment", fragments=request.fragments,
                                          language=request.language, start=request.start, duration=request.duration)
                result["gpuUtilization"] = gpu.mean()
                return result
    except WorkerBusy:
        raise HTTPException(409, "The local alignment worker is busy.")
    except AlignmentTimeout as error:
        raise HTTPException(504, error_detail(str(error), started, engine))
    except HTTPException:
        raise
    except Exception as error:
        print(f"[anchor] failed: {error!r}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        raise HTTPException(422, error_detail("Local speech recovery is unavailable. Check that the required model is installed on the media drive.", started, engine))

@app.post("/anchor-batch")
def anchor_batch(request: AnchorBatchRequest):
    token = os.environ.get("ALIGNMENT_WORKER_TOKEN", "")
    if not token or not secrets.compare_digest(request.token, token):
        raise HTTPException(401, "Worker authentication required.")
    started = time.monotonic()
    engine = CTC_ENGINE
    try:
        with gate.hold():
            with GpuMonitor() as gpu:
                expected = os.environ.get("MEDIA_VOLUME_ID")
                marker = root / ".media-volume"
                if expected and (not marker.is_file() or marker.read_text().strip() != expected):
                    raise HTTPException(503, "The media drive is unavailable.")
                audio = checked_path(request.audio, True)
                if request.language != "eng":
                    return {"engine": engine, "outcome": "language_not_supported",
                            "stageTimings": {"requestValidation": time.monotonic() - started},
                            "results": [], "gpuUtilization": None}
                output = checked_path(request.output)
                if not output.is_relative_to(root / "alignment"):
                    raise HTTPException(400, "Alignment output must be in its cache directory.")
                result = align_ctc_batch_locate(
                    audio=audio, output=output, fragments=request.fragments, language=request.language,
                    windows=[window.model_dump() for window in request.windows],
                    media_folder=root / "alignment", recording_id=request.recordingId,
                    recording_fingerprint=request.audioFingerprint, track_id=request.trackId,
                    microbatch=request.microbatch)
                result["gpuUtilization"] = gpu.mean()
                return result
    except WorkerBusy:
        raise HTTPException(409, "The local alignment worker is busy.")
    except AlignmentTimeout as error:
        raise HTTPException(504, error_detail(str(error), started, engine))
    except HTTPException:
        raise
    except Exception as error:
        print(f"[anchor-batch] failed: {error!r}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        raise HTTPException(422, error_detail("Local speech recovery is unavailable. Check that the required model is installed on the media drive.", started, engine))

def error_detail(message, started, engine=ENGINE):
    return {"message": message, "engine": engine, "outcome": "error",
            "stageTimings": {"failedRequest": time.monotonic() - started}}

def checked_path(value: str, must_exist=False):
    path = Path(value).resolve()
    if not path.is_relative_to(root) or (must_exist and not path.is_file()):
        raise HTTPException(400, "The audio must be on the configured media drive.")
    return path

@app.get("/health")
def health():
    # The CTC worker must have both its pinned runtime and checkpoint available.
    # CUDA is checked against the actual runtime rather than the host name.
    requested = os.environ.get("ALIGNMENT_CTC_DEVICE", "cpu")
    device = requested.split(":", 1)[0]
    ctc_ready = False
    try:
        import torch
        import torchaudio
        selected = torch.device(requested)
        ctc_ready = (selected.type in {"cpu", "cuda"} and
                     torch.__version__.split("+")[0] == "2.8.0" and
                     torchaudio.__version__.split("+")[0] == "2.8.0" and
                     checkpoint_path(root / "alignment").is_file() and
                     (selected.type != "cuda" or
                      (torch.cuda.is_available() and
                       (selected.index is None or selected.index < torch.cuda.device_count()))))
    except (ImportError, OSError, RuntimeError, ValueError):
        pass
    anchor_ready = (importlib.util.find_spec("faster_whisper") is not None and
                    (root / "alignment" / "models" / "whisper").is_dir())
    return {"ready": True, "engine": ENGINE, "busy": gate.busy, "stuck": gate.stuck,
            "busySeconds": gate.busy_seconds(), "lastTimeout": gate.last_timeout,
            "slots": gate.slots, "activeRequests": gate.active,
            "mediaRoot": str(root), "ctc": {"engine": CTC_ENGINE, "ready": ctc_ready,
            "device": device, "precision": "float16" if device == "cuda" else "float32",
            "anchorReady": anchor_ready, "passageReady": True, "anchorBatch": True}}

@app.post("/align")
def align(request: AlignRequest):
    token = os.environ.get("ALIGNMENT_WORKER_TOKEN", "")
    if not token or not secrets.compare_digest(request.token, token):
        raise HTTPException(401, "Worker authentication required.")
    started = time.monotonic()
    engine = CTC_ENGINE if request.engine == "ctc" else ENGINE
    try:
        with gate.hold():
            with GpuMonitor() as gpu:
                marker = root / ".media-volume"
                expected = os.environ.get("MEDIA_VOLUME_ID")
                if expected and (not marker.is_file() or marker.read_text().strip() != expected):
                    raise HTTPException(503, "The media drive is unavailable.")
                audio = checked_path(request.audio, True)
                output = checked_path(request.output)
                if not output.is_relative_to(root / "alignment"):
                    raise HTTPException(400, "Alignment output must be in its cache directory.")
                if request.language not in ({"eng"} if request.engine == "ctc" else LANGUAGES):
                    elapsed = time.monotonic() - started
                    return {"engine": engine, "outcome": "language_not_supported", "stageTimings": {"requestValidation": elapsed}, "elapsedSeconds": elapsed, "intervals": [], "gpuUtilization": None}
                if request.engine == "ctc":
                    for window in request.prefetch:
                        try:
                            ctc_prefetch.prefetch(checked_path(window.audio, True), window.start, window.duration, root / "alignment")
                        except HTTPException:
                            pass
                operation = align_ctc_section if request.engine == "ctc" else align_section
                identity = ({"recording_id": request.recordingId, "recording_fingerprint": request.audioFingerprint,
                             "track_id": request.trackId, "microbatch": request.microbatch} if request.engine == "ctc" else {})
                result = operation(audio=audio, output=output, fragments=request.fragments, language=request.language,
                                 start=request.start, duration=request.duration, media_folder=root / "alignment", **identity)
                result["gpuUtilization"] = gpu.mean()
                return result
    except WorkerBusy:
        raise HTTPException(409, "The local alignment worker is busy.")
    except AlignmentTimeout as error:
        raise HTTPException(504, error_detail(str(error), started, engine))
    except HTTPException:
        raise
    except Exception as error:
        print(f"[align] failed: {error!r}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        raise HTTPException(422, error_detail("Local alignment could not match this section. Check the edition and chapter pairing.", started, engine))
