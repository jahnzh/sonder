"""Local known-text alignment. This service never downloads or uploads audio."""
import os
import secrets
import sys
import threading
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from deadline import AlignmentTimeout, Gate, WorkerBusy, worker_slots
from ctc_acoustic import ENGINE as CTC_ENGINE, checkpoint_path
from ctc_pipeline import align_ctc_batch_locate, align_ctc_section, shutdown_locate_pool
from ctc_decode import evict_decoded
from ctc_gpu import GpuMonitor
import ctc_prefetch
from book_job import BOOK_ENGINE, BookJobs, JobConflict, NotReady, Resuming, UnknownJob, WorkerStages
from book_session import BudgetExceeded
from revision import read_revision

root = Path(os.environ.get("MEDIA_ROOT", "/mnt/usb_4t_1/sonder")).resolve()
# Read once at startup; None (unknown) when the file is missing or unreadable (#357).
REVISION = read_revision()


def _book_model():
    from ctc_acoustic import resident_model
    return resident_model(root / "alignment")


# Whole-book jobs (#402): one per book, in their own folder under the alignment cache.
book_jobs = BookJobs(root / "alignment" / "book-jobs",
                     WorkerStages(root / "alignment", _book_model, os.environ.get("ALIGNMENT_CTC_DEVICE", "cpu"),
                                  gpu_monitor=GpuMonitor))
_book_sweeper_stop = threading.Event()


def _sweep_book_jobs():
    while not _book_sweeper_stop.wait(30):
        try:
            book_jobs.sweep()
        except Exception as error:  # noqa: BLE001 - the sweeper must keep running
            print(f"[book-jobs] sweep failed: {error!r}", file=sys.stderr, flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Cap decoded WAVs left by prior runs before accepting work.
    try:
        evict_decoded(root / "alignment")
    except OSError:
        pass
    # Unfinished whole-book jobs continue where they stopped (finished tracks and groups are kept). In the
    # background: retained folders never delay /health or the window endpoints; book requests get 503 meanwhile.
    book_jobs.resume_in_background()
    sweeper = threading.Thread(target=_sweep_book_jobs, name="book-job-sweeper", daemon=True)
    sweeper.start()
    try:
        yield
    finally:
        # Persistent WSL/lisa workers must not retain book-sized locate indexes after stop.
        shutdown_locate_pool()
        ctc_prefetch.shutdown()
        _book_sweeper_stop.set()
        book_jobs.shutdown()


app = FastAPI(lifespan=lifespan)
gate = Gate(worker_slots())
# Whole-book encode batches hold this gate's slots too, after the window requests; they are not counted in
# /health's busy, activeRequests, busySeconds or stuck (deadline.Gate).
book_jobs.stages.admission = gate

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
    engine: Literal["ctc"] = "ctc"
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
                    return {"engine": engine, "outcome": "language_not_supported", "stageTimings": {"requestValidation": time.monotonic() - started}, "match": None, "gpuUtilization": None}
                output = checked_path(request.output)
                if not output.is_relative_to(root / "alignment"):
                    raise HTTPException(400, "Alignment output must be in its cache directory.")
                result = align_ctc_section(audio=audio, output=output, fragments=request.fragments,
                                           language=request.language, start=request.start, duration=request.duration,
                                           media_folder=root / "alignment", recording_id=request.recordingId,
                                           recording_fingerprint=request.audioFingerprint, track_id=request.trackId, locate=True,
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

def error_detail(message, started, engine=CTC_ENGINE):
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
    return {"ready": True, "engine": CTC_ENGINE, "revision": REVISION, "busy": gate.busy, "stuck": gate.stuck,
            "busySeconds": gate.busy_seconds(), "lastTimeout": gate.last_timeout,
            "slots": gate.slots, "activeRequests": gate.active,
            "mediaRoot": str(root), "ctc": {"engine": CTC_ENGINE, "ready": ctc_ready,
            "device": device, "precision": "float16" if device == "cuda" else "float32",
            "anchorReady": ctc_ready, "passageReady": True, "anchorBatch": True},
            # Book work is reported here only: the fields above describe window requests, as before #402.
            # None of these waits on a lock that book bookkeeping holds across disk I/O (book_job.BookJobs).
            "bookJobs": {"engine": BOOK_ENGINE, "ready": ctc_ready, "jobs": len(book_jobs.keys()),
                         "resuming": book_jobs.resuming,
                         "slotsHeld": gate.background_active, "batchSeconds": gate.background_seconds(),
                         "stuck": book_jobs.registry.stuck(),
                         "diskReservedBytes": book_jobs.registry.budget.reserved(),
                         "diskBudgetBytes": book_jobs.registry.budget.total}}

@app.post("/align")
def align(request: AlignRequest):
    token = os.environ.get("ALIGNMENT_WORKER_TOKEN", "")
    if not token or not secrets.compare_digest(request.token, token):
        raise HTTPException(401, "Worker authentication required.")
    started = time.monotonic()
    engine = CTC_ENGINE
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
                if request.language != "eng":
                    elapsed = time.monotonic() - started
                    return {"engine": engine, "outcome": "language_not_supported", "stageTimings": {"requestValidation": elapsed}, "elapsedSeconds": elapsed, "intervals": [], "gpuUtilization": None}
                for window in request.prefetch:
                    try:
                        ctc_prefetch.prefetch(checked_path(window.audio, True), window.start, window.duration, root / "alignment")
                    except HTTPException:
                        pass
                result = align_ctc_section(audio=audio, output=output, fragments=request.fragments, language=request.language,
                                           start=request.start, duration=request.duration, media_folder=root / "alignment",
                                           recording_id=request.recordingId, recording_fingerprint=request.audioFingerprint,
                                           track_id=request.trackId, microbatch=request.microbatch)
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


# ------------------------------------------------------------------ whole-book jobs (#402, ADR 0016)
# Request, progress and result shapes: docs/CTC_WORKER_POOL.md ("Whole-book jobs").

class BookSentence(BaseModel):
    id: str = Field(min_length=1, max_length=512)
    section: int = Field(default=0, ge=0)
    text: str = Field(max_length=20000)

class BookTrack(BaseModel):
    id: str = Field(min_length=1, max_length=512)
    audio: str = Field(min_length=1, max_length=4096)
    duration: float = Field(gt=0, le=200000)

class BookSection(BaseModel):
    index: int = Field(ge=0)
    title: str = Field(default="", max_length=2000)

class BookJobRequest(BaseModel):
    jobId: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    recordingId: str = Field(min_length=1, max_length=512)
    audioFingerprint: str | None = Field(default=None, max_length=512)
    language: str = "eng"
    sentences: list[BookSentence] = Field(min_length=1, max_length=200000)
    tracks: list[BookTrack] = Field(min_length=1, max_length=2000)
    # Optional (#403): the sections' titles, for the result's unsynced passages and flags.
    sections: list[BookSection] | None = Field(default=None, max_length=200000)

# The largest request of the 2026-11-14 set is 7.8 MB (an ebook of the complete works, 71,225 sentences);
# the 33 h book's is 2.9 MB. 32 MiB is four times the largest, and about the size of a request at the
# model's limit of 200,000 sentences of that book's average length. Anything larger is refused unread.
BOOK_REQUEST_MAX_BYTES = 32 * 1024 * 1024


def _book_auth(authorization):
    token = os.environ.get("ALIGNMENT_WORKER_TOKEN", "")
    supplied = (authorization or "").removeprefix("Bearer ").strip()
    if not token or not secrets.compare_digest(supplied, token):
        raise HTTPException(401, "Worker authentication required.")


async def _book_request_body(request: Request):
    """The body, read only after the token check and never past BOOK_REQUEST_MAX_BYTES."""
    limit = BOOK_REQUEST_MAX_BYTES
    too_large = HTTPException(413, f"A book request may have at most {limit} bytes.")
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > limit:
                raise too_large
        except ValueError:
            raise HTTPException(400, "Invalid Content-Length.")
    body = bytearray()
    async for chunk in request.stream():  # also bounds a chunked body without a Content-Length
        body += chunk
        if len(body) > limit:
            raise too_large
    return bytes(body)

def _media_ready():
    expected = os.environ.get("MEDIA_VOLUME_ID")
    marker = root / ".media-volume"
    if expected and (not marker.is_file() or marker.read_text().strip() != expected):
        raise HTTPException(503, "The media drive is unavailable.")

@app.post("/book-jobs", status_code=202)
async def start_book_job(request: Request):
    # The body is not a declared parameter: FastAPI would read and parse all of it before the token check.
    _book_auth(request.headers.get("authorization"))
    raw = await _book_request_body(request)
    try:
        parsed = BookJobRequest.model_validate_json(raw)
    except ValidationError as error:
        raise RequestValidationError([{**e, "loc": ("body", *e["loc"])} for e in error.errors(include_url=False, include_input=False)])
    return await run_in_threadpool(_start_book_job, parsed)


def _start_book_job(request: BookJobRequest):
    _media_ready()
    body = request.model_dump()
    for track in body["tracks"]:
        track["audio"] = str(checked_path(track["audio"], True))
    try:
        return book_jobs.start(body)
    except Resuming as error:
        raise HTTPException(503, str(error))
    except JobConflict as error:
        raise HTTPException(409, str(error))
    except BudgetExceeded as error:
        raise HTTPException(507, str(error))

@app.get("/book-jobs/{job_id}")
def book_job_status(job_id: str, authorization: str | None = Header(default=None)):
    _book_auth(authorization)
    try:
        return book_jobs.status(job_id)
    except Resuming as error:
        raise HTTPException(503, str(error))
    except UnknownJob:
        raise HTTPException(404, "Unknown book job.")

@app.delete("/book-jobs/{job_id}")
def cancel_book_job(job_id: str, authorization: str | None = Header(default=None)):
    _book_auth(authorization)
    try:
        return book_jobs.cancel(job_id)
    except Resuming as error:
        raise HTTPException(503, str(error))
    except UnknownJob:
        raise HTTPException(404, "Unknown book job.")

@app.get("/book-jobs/{job_id}/result")
def book_job_result(job_id: str, authorization: str | None = Header(default=None)):
    _book_auth(authorization)
    try:
        return book_jobs.result(job_id)
    except Resuming as error:
        raise HTTPException(503, str(error))
    except UnknownJob:
        raise HTTPException(404, "Unknown book job.")
    except NotReady as error:
        return JSONResponse(status_code=409, content={"jobId": job_id, "engine": BOOK_ENGINE,
                                                      "state": str(error), "message": "The job has not finished."})
