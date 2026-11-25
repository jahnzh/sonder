"""Whole-book alignment jobs on the worker (#402, ADR 0016). The control flow is standard library only.

A job is started with the book's sentences, the staged tracks and the recording's identity; the server
reads its progress, can cancel it and fetches the result (an alignment map in the server's interval
shape). Each job runs in its own thread through these stages, all on disk under
`MEDIA_ROOT/alignment/book-jobs/<jobId>/`:

1. decode: every track whose emissions are not complete, on the container timeline (`book_audio`);
2. encode: one continuous pass over the tracks, inside the device's encode queue (`book_encode`);
   a track's PCM is deleted as soon as its emissions are written;
3. anchor: the anchor chain over the whole book gives the groups (`groups/plan.json`);
4. align: the groups in the session's process pool, each written to `groups/<n>.json` when done;
5. finish: merge (seam fix), the worker's validation, intervals in track time -> `result.json`.

Groups are the unit of progress and resume: after a worker restart the jobs that had not finished are
resumed from their folders, and finished tracks' emissions and finished groups are not computed again.
The per-book session (`book_session`) holds the job's resources and ends on result fetched, cancel, or
IDLE_SECONDS without a request from the server.
"""
import hashlib
import json
import os
import re
import shutil
import threading
import time
import traceback
from pathlib import Path

from book_session import (BudgetExceeded, SessionEnded, SessionRegistry, emission_bytes, folder_bytes,
                          meta_bytes)

# A failed job keeps only this record (its state.json) until the idle sweep removes it; the error is cut to
# ERROR_CHARS, so the record stays a few KB (ids are at most 512 characters).
ERROR_CHARS = 2000
RECORD_KEYS = ("jobId", "engine", "digest", "state", "recordingId", "createdAt", "updatedAt", "error",
               "resumed", "stopReason")

# A new aligner, so a new engine generation (ADR 0016). The window endpoints keep ctc_acoustic.ENGINE.
# book-v2 (#403): the leftover pass adds intervals the v1 chain never produced (chapters out of the ebook's
# order) and a wrong book ends as `text_mismatch` instead of an empty map, so a map's content depends on the
# generation. Retained folders of book-v1 start over (their emissions carry the engine in their identity).
BOOK_ENGINE = "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2"
# torchaudio WAV2VEC2_ASR_BASE_960H labels (the emissions' 29 classes, blank first).
LABELS = ("-", "|", "E", "T", "A", "O", "N", "I", "H", "S", "R", "D", "L", "U", "M", "W", "C", "F", "G", "Y",
          "P", "B", "V", "K", "'", "X", "J", "Q", "Z")
JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
TERMINAL = ("done", "failed", "cancelled")
# Room for state.json (and its temporary copy) next to the request: what a new job reserves on top of it.
STATE_BYTES = 64 * 1024
# How long cancel, fetch and idle end wait for the job's thread to stop before the session is kept as stuck.
STOP_WAIT_S = 30.0
STATES = ("queued", "decoding", "encoding", "anchoring", "aligning", "finishing") + TERMINAL
# How often the encode writes how much audio it has encoded (`audioSecondsEncoded`). A track's count moves only
# when the whole track is done, and one M4B of 23.6 h takes hours on lisa's CPU: without this the job looks stuck.
ENCODE_PROGRESS_S = 15.0
SAMPLE_RATE = 16000


def encode_progress(job, done_samples, work, every=None, clock=time.monotonic):
    """`on_progress(position, end)` for `encode_tracks`: records the audio encoded so far, in whole seconds of the
    recording (`audioSecondsEncoded` of `audioSecondsTotal`), at most every `every` seconds. `done_samples` are
    the samples of the tracks whose emissions were complete before this encode; `work` the tracks it encodes,
    in order. The totals are written at once."""
    every = ENCODE_PROGRESS_S if every is None else every
    starts = []
    total = done_samples
    for track in work:
        starts.append(total)
        total += track["samples"]
    total_seconds = int(total // SAMPLE_RATE)
    last = {"at": clock(), "seconds": int(done_samples // SAMPLE_RATE)}
    job.progress(audioSecondsEncoded=last["seconds"], audioSecondsTotal=total_seconds)

    def on_progress(position, end):
        seconds = min(total_seconds, int((starts[position] + end) // SAMPLE_RATE))
        now = clock()
        if seconds == last["seconds"] or (now - last["at"] < every and seconds < total_seconds):
            return
        last.update(at=now, seconds=seconds)
        job.progress(audioSecondsEncoded=seconds)

    return on_progress


class JobConflict(Exception):
    """The job id exists with a different request."""


class UnknownJob(Exception):
    pass


class Resuming(Exception):
    """A book request that came while the worker still picks up its retained jobs (503, retry shortly)."""


class NotReady(Exception):
    """The result was asked for before the job finished."""


class Stopped(Exception):
    """The job thread was told to stop (cancel, idle end or worker stop)."""


def request_digest(request):
    keys = ("recordingId", "audioFingerprint", "language", "sentences", "tracks", "sections")
    canonical = json.dumps({k: request.get(k) for k in keys}, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")))
    temporary.replace(path)


def json_chunks(value):
    """write_json's exact text in pieces, so it can be counted and written without holding it whole.
    ASCII (`ensure_ascii`): one byte per character."""
    return json.JSONEncoder(separators=(",", ":")).iterencode(value)


def write_reserved(job, session, path, value, should_stop, state_bytes=STATE_BYTES, what="result"):
    """Write `value` as JSON to `path` only once the bytes it needs are reserved (#402: every byte a book
    job writes is reserved before it is written; #403 review: a result's passages and flags repeat section
    titles, so no estimate bounds it). The text is counted first, then the peak of the write is reserved:
    the job's folder as it is now (an older copy of the file included, which stays until the new one
    replaces it), the new file's temporary copy beside it, and `state_bytes` for the state file's next
    writes. A result that can never fit the budget fails the job (BudgetExceeded) and nothing is written.
    Returns the file's size in bytes."""
    path = Path(path)
    size = sum(len(chunk) for chunk in json_chunks(value))
    need = folder_bytes(job.folder) + size + int(state_bytes)
    try:
        session.reserve_disk(need, should_wait=lambda: not should_stop())
    except BudgetExceeded as error:
        raise BudgetExceeded(f"The book's {what} is {size} bytes of JSON and was not written: with the job's "
                             f"other files it needs {need} bytes of disk. {error}") from None
    job.progress(diskReservedBytes=need)
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("w", encoding="ascii") as out:
            for chunk in json_chunks(value):
                out.write(chunk)
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return size


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def words_in(text):
    return len(text.split())


def emissions_key(metas):
    """Identity of the book's emissions: every track's source hash and engine, in order, with its frames.

    The concatenated emissions, the plan and the finished groups are all computed from these emissions and
    carry this key; when any track changes they are invalidated together."""
    parts = [{"index": m["index"], "identity": m.get("identity"), "frames": m["frames"]} for m in metas]
    return hashlib.sha256(json.dumps(parts, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def discard_partial(folder):
    """Delete what an unfinished job can never reuse: decoded PCM (a track without complete emissions is
    decoded again) and the partial files of an interrupted write."""
    folder = Path(folder)
    shutil.rmtree(folder / "tracks", ignore_errors=True)
    for part in list((folder / "emissions").glob("*.part")) + list(folder.glob("*.tmp")):
        part.unlink(missing_ok=True)


class Job:
    def __init__(self, key, folder, request, digest, state):
        self.key = key
        self.folder = Path(folder)
        self.request = request
        self.digest = digest
        self.state = state
        self.stop = threading.Event()
        self.stop_reason = None
        self.thread = None
        # Locks (#402 round 4: none that /health, a window request or the gate waits on is held across I/O):
        # `lock` guards `state` in memory only, never held across I/O; the job thread and status wait on it.
        self.lock = threading.Lock()
        # `save_lock` serialises state.json writes and is held across them; only the job thread and book
        # requests wait on it (the gate calls the wait report only while the book holds no slot).
        self.save_lock = threading.Lock()  # taken before self.lock, never after it
        self.last_request = time.monotonic()
        self.cancelled = False  # set by cancel and idle end; a cancelled job is never launched again
        self.resume_waiting = False  # a retained job waiting for its turn to resume (resume_all)
        # One end at a time (BookJobs._end_job), held across the thread join and the folder delete; only
        # cancel, fetch and the idle sweeper wait on it. Taken before every other lock.
        self.end_lock = threading.Lock()
        self.end_outcome = None  # the outcome of that end, for the callers that waited for it

    def save(self):
        # The job thread and request threads (cancel) both save; one at a time, as the temporary name is shared.
        with self.save_lock:
            with self.lock:
                state = dict(self.state)
            try:
                write_json(self.folder / "state.json", state)
            except FileNotFoundError:
                if not self.stop.is_set():
                    raise  # the folder is gone only after a cancel or an idle end

    def update(self, **changes):
        with self.lock:
            self.state.update(changes)
            self.state["updatedAt"] = time.time()
        self.save()

    def progress(self, **changes):
        with self.lock:
            self.state.setdefault("progress", {}).update(changes)
            self.state["updatedAt"] = time.time()
        self.save()

    def timing(self, name, seconds):
        with self.lock:
            timings = self.state.setdefault("stageTimings", {})
            timings[name] = timings.get(name, 0.0) + seconds
        self.save()

    def gate_wait(self, waiting):
        """The encode waits for the window endpoints' gate (window requests come first), or got it again."""
        now = time.time()
        with self.lock:
            progress = self.state.setdefault("progress", {})
            if waiting:
                progress["waitingForWindowRequests"] = True
                progress["gateWaitSince"] = now
            else:
                since = progress.pop("gateWaitSince", None)
                progress["waitingForWindowRequests"] = False
                if since is not None:
                    timings = self.state.setdefault("stageTimings", {})
                    timings["gateWait"] = timings.get("gateWait", 0.0) + max(0.0, now - since)
            self.state["updatedAt"] = now
        self.save()


class BookJobs:
    """All whole-book jobs of one worker process."""

    def __init__(self, root, stages, registry=None, clock=time.monotonic, state_bytes=STATE_BYTES):
        self.root = Path(root)
        self.state_bytes = state_bytes
        self.stages = stages
        self.registry = registry or SessionRegistry()
        self._clock = clock
        # Guards _jobs and job launches, and is held across book bookkeeping on disk (start, resume): only
        # book requests, the resume thread, the sweeper and shutdown wait on it, never /health, a window
        # request or the gate. /health and status read `_view` instead.
        self._lock = threading.Lock()
        self._jobs = {}
        # A copy of _jobs, replaced (never changed) under _lock after each change: read without any lock.
        self._view = {}
        self._closed = False
        self.resuming = False  # True while resume_in_background has not finished; book requests get 503

    def _publish(self):
        """Call with _lock held, after changing _jobs."""
        self._view = dict(self._jobs)

    def _ready(self):
        if self.resuming:
            raise Resuming("The worker is still picking up its retained book jobs. Retry shortly.")

    # ------------------------------------------------------------ requests

    def start(self, request):
        key = request["jobId"]
        if not JOB_ID.match(key or ""):
            raise ValueError("Invalid job id.")
        self._ready()
        digest = request_digest(request)
        with self._lock:
            job = self._jobs.get(key)
            if job is None:
                if self.registry.is_stuck(key):
                    raise JobConflict("This job id belongs to a job that is still stopping.")
                folder = self.root / key
                stored = read_json(folder / "request.json")
                if stored is not None and request_digest(stored) != digest:
                    raise JobConflict("This job id belongs to another request.")
                new = not folder.exists()
                before = folder_bytes(folder)
                wrote = [name for name in ("request.json", "state.json") if not (folder / name).exists()]
                # The request and state files are written now, before the job reserves its first stage. They
                # must fit in the budget next to the other books, or the request is refused (DiskFull, 507)
                # before anything is written. write_json writes this exact text (ASCII, so len is bytes).
                self.registry.budget.fits_now(
                    key, before + len(json.dumps(request, separators=(",", ":"))) + self.state_bytes)
                try:
                    self.registry.open(key, folder)
                    job = self._load_or_create(key, folder, request, digest)
                except BaseException:
                    self._undo_start(key, folder, new, wrote, before)
                    raise
                self._jobs[key] = job
                self._publish()
            elif job.digest != digest:
                raise JobConflict("This job id belongs to another request.")
            self._touch(job)
            if (job.state["state"] not in TERMINAL and not job.resume_waiting
                    and (job.thread is None or not job.thread.is_alive())):
                self._launch(job)
        return self.status(key)

    def _undo_start(self, key, folder, new, wrote, before):
        """A start that failed deletes what it wrote; what it could not delete stays reserved (and a new
        folder's session is kept as stuck until `sweep` deletes it)."""
        if new:
            self.registry.end(key, "failed", delete=True)
            return
        for path in [folder / name for name in wrote] + list(folder.glob("*.tmp")):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        self.registry.end(key, "failed", delete=False, keep=max(0, folder_bytes(folder) - before))

    def status(self, key):
        job = self._job(key)
        self._touch(job)
        with job.lock:
            state = json.loads(json.dumps(job.state))
        state.pop("digest", None)
        progress = state.get("progress") or {}
        since = progress.pop("gateWaitSince", None)
        if since is not None:
            progress["gateWaitSeconds"] = round(max(0.0, time.time() - since), 1)
        if state["state"] == "encoding":
            position = self.stages.encode_position(key)
            state.setdefault("progress", {})["encodeQueuePosition"] = position
        return state

    def cancel(self, key):
        job = self._job(key)
        with self._lock:
            job.cancelled = True
        self._stop(job, "cancelled")
        if job.state["state"] not in TERMINAL or job.state["state"] == "done":
            job.update(state="cancelled", error=None)
        self._end_job(job, "cancelled")
        return {"jobId": key, "engine": BOOK_ENGINE, "state": "cancelled"}

    def result(self, key):
        job = self._job(key)
        self._touch(job)
        if job.state["state"] != "done":
            raise NotReady(job.state["state"])
        result = read_json(job.folder / "result.json")
        if result is None:
            raise NotReady("missing")
        # The session ends on fetch: the whole folder goes and its reservation is released with it. Later
        # requests for the job answer 404 (unknown job).
        with self._lock:
            job.cancelled = True
        self._end_job(job, "fetched")
        return result

    def _end_job(self, job, reason):
        """Stop the job's thread and processes, then delete its folder and release its reservation together.
        When a group process or the thread is still there after the bounded waits, the session keeps both
        and is reported as stuck (`bookJobs.stuck` in /health) until `sweep` sees them gone.

        One end per job: cancel, fetch and the idle sweep can end the same job at once; a later caller
        waits for the first end and returns its outcome without touching the folder or the budget."""
        with job.end_lock:
            if job.end_outcome is not None:
                return job.end_outcome
            if job.thread is not None and job.thread is not threading.current_thread():
                job.thread.join(timeout=STOP_WAIT_S)
            thread = job.thread
            busy = None if thread is None or thread is threading.current_thread() else thread.is_alive
            outcome = self.registry.end(job.key, reason, delete=True, busy=busy)
            if outcome is False:
                # No session (a failed job's error record): end one for its folder, so the record goes the
                # same way, only once the thread is gone.
                self.registry.open(job.key, job.folder)
                outcome = self.registry.end(job.key, reason, delete=True, busy=busy)
            job.end_outcome = outcome
            with self._lock:
                if self._jobs.get(job.key) is job:
                    self._jobs.pop(job.key, None)
                    self._publish()
            return outcome

    # ------------------------------------------------------------ lifecycle

    def resume_in_background(self):
        """Worker start: `resume_all` in its own thread, so the worker serves /health and the window
        endpoints at once however long the retained folders take to read. Until it has finished (or
        failed), book requests are answered 503 (`Resuming`), so none of them meets a half-loaded job."""
        self.resuming = True

        def run():
            try:
                self.resume_all()
            except Exception as error:  # noqa: BLE001 - book requests are served again either way
                print(f"[book-jobs] resume failed: {error!r}", flush=True)
                traceback.print_exc()
            finally:
                self.resuming = False

        thread = threading.Thread(target=run, name="book-job-resume-all", daemon=True)
        thread.start()
        return thread

    def resume_all(self):
        """Worker start: pick up every job folder; unfinished jobs continue where they stopped.

        Every retained folder's files are claimed in the disk budget before any job is launched, so the
        jobs that resume (and new ones) are admitted against what the disk really holds. Unfinished jobs
        resume one at a time, oldest first: a job waiting for its turn holds its claim (parked, see
        `DiskBudget`), so a resumed job that could fit only with those bytes fails at once instead of two
        resumed jobs waiting for each other's disk. Returns their keys in resume order."""
        if not self.root.is_dir():
            return []
        loaded = []
        for folder in sorted(p for p in self.root.iterdir() if p.is_dir()):
            if self._closed:
                return []  # the worker stops: what is not loaded yet stays on disk for the next start
            request = read_json(folder / "request.json")
            state = read_json(folder / "state.json") or {}
            record = (request is None and JOB_ID.match(folder.name) and state.get("jobId") == folder.name
                      and state.get("state") == "failed" and state.get("digest"))
            if not record and (request is None or not JOB_ID.match(folder.name) or request.get("jobId") != folder.name):
                # Not a job of this worker: its files still take space; they are never deleted here.
                key = f"untracked/{folder.name}"
                self.registry.budget.claim(key, folder_bytes(folder))
                self.registry.budget.park(key)
                continue
            with self._lock:
                if folder.name in self._jobs:
                    continue
                if record:  # a failed job's error record, until the idle sweep
                    job = Job(folder.name, folder, None, state["digest"], state)
                    self.registry.budget.claim(job.key, folder_bytes(folder))
                else:
                    job = self._load_or_create(folder.name, folder, request, request_digest(request))
                    if job.state["state"] not in TERMINAL:
                        discard_partial(folder)  # never reused: not claimed, so it holds no other book up
                    self.registry.open(job.key, folder).claim_disk(folder_bytes(folder))
                self._jobs[folder.name] = job
                self._publish()
                job.last_request = self._clock()
            loaded.append(job)
        waiting = sorted((job for job in loaded if job.state["state"] not in TERMINAL),
                         key=lambda job: (job.state.get("createdAt") or 0, job.key))
        for position, job in enumerate(waiting, 1):
            self.registry.budget.park(job.key)
            job.resume_waiting = True
            job.update(state="queued", resumed=job.state.get("resumed", 0) + 1)
            job.progress(resumeQueuePosition=position)
        if waiting:
            threading.Thread(target=self._resume_in_turn, args=(waiting,), name="book-job-resume",
                             daemon=True).start()
        return [job.key for job in waiting]

    def _resume_in_turn(self, waiting):
        for index, job in enumerate(waiting):
            with self._lock:
                if self._closed:
                    return
                launch = self._jobs.get(job.key) is job and not job.cancelled
                job.resume_waiting = False
                if launch:
                    self.registry.budget.unpark(job.key)
                    for position, later in enumerate(waiting[index + 1:], 1):
                        later.progress(resumeQueuePosition=position)
                    job.progress(resumeQueuePosition=None)
                    self._launch(job)
            if launch and job.thread is not None:
                job.thread.join()

    def sweep(self):
        """End jobs the server has not asked about for the idle time, and release stuck sessions whose
        processes have exited since. Returns the keys of the jobs ended."""
        self.registry.retry_stuck()
        now = self._clock()
        with self._lock:
            idle = [job for job in self._jobs.values() if now - job.last_request >= self.registry.idle]
            for job in idle:
                job.cancelled = True
        for job in idle:
            self._stop(job, "idle")
            self._end_job(job, "idle")
        return [job.key for job in idle]

    def shutdown(self):
        """Worker stop: stop the threads, release the sessions, keep the folders for resume. A job whose
        thread is still running after STOP_WAIT_S keeps its reservation and is reported stuck."""
        with self._lock:
            self._closed = True
            jobs = list(self._jobs.values())
        for job in jobs:
            self._stop(job, "worker stop")
        for job in jobs:
            if job.thread is not None:
                job.thread.join(timeout=STOP_WAIT_S)
        self.registry.close_all(busy={job.key: job.thread.is_alive for job in jobs if job.thread is not None})

    def keys(self):
        return list(self._view)  # no lock: /health reads it while a start or the resume is on disk

    # ------------------------------------------------------------ internals

    def _job(self, key):
        self._ready()
        job = self._view.get(key)
        if job is None:
            raise UnknownJob(key)
        return job

    def _touch(self, job):
        job.last_request = self._clock()
        session = self.registry.get(job.key)
        if session is not None:
            session.touch()

    def _stop(self, job, reason):
        if job.stop_reason is None:
            job.stop_reason = reason
        job.stop.set()

    def _load_or_create(self, key, folder, request, digest):
        folder.mkdir(parents=True, exist_ok=True)
        state = read_json(folder / "state.json")
        if state is None or state.get("digest") != digest or state.get("engine") != BOOK_ENGINE:
            # A new job, or one written by another aligner generation: start it over.
            for name in ("tracks", "emissions", "groups"):
                shutil.rmtree(folder / name, ignore_errors=True)
            (folder / "result.json").unlink(missing_ok=True)
            state = {"jobId": key, "engine": BOOK_ENGINE, "digest": digest, "state": "queued",
                     "recordingId": request.get("recordingId"), "createdAt": time.time(),
                     "updatedAt": time.time(), "progress": {"tracksTotal": len(request["tracks"])},
                     "stageTimings": {}, "error": None, "resumed": 0}
            write_json(folder / "request.json", request)
        job = Job(key, folder, request, digest, state)
        job.save()
        return job

    def _launch(self, job):
        if self._closed or job.cancelled:
            return
        job.stop.clear()
        job.stop_reason = None
        job.thread = threading.Thread(target=self._run, args=(job,), name=f"book-job-{job.key}", daemon=True)
        job.thread.start()

    def _run(self, job):
        session = self.registry.open(job.key, job.folder)

        def should_stop():
            return job.stop.is_set() or session.ended is not None

        try:
            if job.request.get("language", "eng") != "eng":
                write_reserved(job, session, job.folder / "result.json",
                               {"jobId": job.key, "engine": BOOK_ENGINE, "outcome": "language_not_supported",
                                "intervals": [], "tracks": []}, should_stop, self.state_bytes)
                self._finish(job, read_json(job.folder / "result.json"))
                return
            self.stages.run(job, session, should_stop)
            if should_stop():
                raise Stopped()
            # The stages wrote the result (reserved from its real size); it is not written a second time.
            self._finish(job, read_json(job.folder / "result.json"))
        except (Stopped, SessionEnded) as error:
            reason = job.stop_reason or str(error) or "stopped"
            if reason == "worker stop":
                return  # resumes on the next start
            if job.state["state"] not in TERMINAL:
                job.update(state="cancelled", error=None, stopReason=reason)
        except BudgetExceeded as error:
            self._fail(job, str(error))
        except Exception as error:  # noqa: BLE001 - every failure must reach the job state
            if should_stop():  # a stage broke because the job was stopped (cancel, idle end or worker stop)
                if job.stop_reason != "worker stop" and job.state["state"] not in TERMINAL:
                    job.update(state="cancelled", error=None, stopReason=job.stop_reason or "stopped")
                return
            print(f"[book-job {job.key}] failed: {error!r}", flush=True)
            traceback.print_exc()
            self._fail(job, str(error) or type(error).__name__)

    def _fail(self, job, message):
        """A failed job keeps only a small error record (its state.json, counted in the budget) until the
        idle sweep. Its processes are stopped first; while one is still there the folder and the whole
        reservation are kept and the session is reported as stuck."""
        with job.lock:
            record = {k: job.state.get(k) for k in RECORD_KEYS if k in job.state}
        record.update(state="failed", error=message[:ERROR_CHARS], updatedAt=time.time())
        # The record (write_json's exact text) is reserved before the rest of the job's bytes are released,
        # so no other book can take them in between.
        keep = len(json.dumps(record, separators=(",", ":")))
        outcome = self.registry.end(job.key, "failed", delete=True, keep=keep)
        if outcome is False:
            return  # another end (worker stop) ended the job first; its folder stays for the resume
        if outcome != "stuck":  # else the folder and the reservation stay until the process is gone
            job.request = None
            try:
                job.folder.mkdir(parents=True, exist_ok=True)
            except OSError:
                pass
        with job.lock:
            job.state = record
        job.save()
        if outcome != "stuck":
            self.registry.budget.claim(job.key, folder_bytes(job.folder))

    def _finish(self, job, result):
        """`result` is what result.json holds: the job is done."""
        if result is None:
            raise RuntimeError("The job finished without a result.")
        job.update(state="done", outcome=result.get("outcome"), error=None)


# ------------------------------------------------------------------ the stages on the real worker

class WorkerStages:
    """Decode, encode, anchor, align and finish with the resident model. `model_loader()` returns a
    `ctc_acoustic.AcousticModel`; `encode_queue(device)` returns the device's `book_encode.EncodeQueue`."""

    def __init__(self, media_folder, model_loader, device="cpu", env=None, gpu_monitor=None, admission=None):
        self.media_folder = Path(media_folder)
        self.model_loader = model_loader
        self.device = device
        self.env = os.environ if env is None else env
        self.gpu_monitor = gpu_monitor
        # The window endpoints' deadline.Gate: each encode batch holds one of its slots (window requests first).
        self.admission = admission

    def encode_position(self, key):
        from book_encode import encode_queue
        return encode_queue(self.device).position(key)

    def align_workers(self):
        default = max(1, min(8, (os.cpu_count() or 2) - 2))
        try:
            value = int(self.env.get("ALIGNMENT_BOOK_ALIGN_WORKERS", str(default)))
        except (TypeError, ValueError):
            return default
        return value if 0 <= value <= 64 else default

    # The order of the stages and what each keeps on disk; the work itself is in the modules.
    def run(self, job, session, should_stop):
        job.update(state="queued")
        metas = self.decode_and_encode(job, session, should_stop)
        if should_stop():
            raise Stopped()
        self.align(job, session, metas, should_stop)

    @staticmethod
    def reserve(job, session, should_stop, adds):
        """Reserve what the job's folder holds now plus `adds` bytes the next stage writes at its peak (and
        room for the small state, plan and group files; the result is reserved when it is written); waits while other books hold the budget."""
        need = folder_bytes(job.folder) + int(adds) + meta_bytes(len(job.request["sentences"]))
        session.reserve_disk(need, should_wait=lambda: not should_stop())
        job.progress(diskReservedBytes=need)

    def track_identity(self, session, index, track):
        from ctc_cache import audio_digest
        digest = session.digests.get(index)
        if digest is None:
            digest, _version = audio_digest(track["audio"])
            session.digests[index] = digest
        return {"engine": BOOK_ENGINE, "sha256": digest}

    def decode_and_encode(self, job, session, should_stop):
        from book_audio import DecodeCancelled, decode_tracks, decoded_samples_bound, peak_bytes, plan_tracks
        from book_encode import EncodeCancelled, complete_emissions, emission_paths, encode_queue, encode_tracks
        from deadline import GateWaitStopped
        tracks = job.request["tracks"]
        decoded_dir = job.folder / "tracks"
        emissions_dir = job.folder / "emissions"
        identities = {}
        missing = []
        started = time.monotonic()
        for index, track in enumerate(tracks):
            if should_stop():
                raise Stopped()
            identities[index] = self.track_identity(session, index, track)
            if complete_emissions(emissions_dir, index, identities[index]) is None:
                missing.append(index)
        job.progress(tracksTotal=len(tracks), tracksEncoded=len(tracks) - len(missing),
                     tracksDecoded=len(tracks) - len(missing))
        job.timing("identity", time.monotonic() - started)
        # PCM is never reused (a track without emissions is decoded again), and unfinished files of a stopped
        # run are worthless: both go before the folder is measured for the budget.
        discard_partial(job.folder)
        # Down to what is left, so a resumed job's claim on files it just deleted holds up no other book.
        session.claim_disk(folder_bytes(job.folder) + STATE_BYTES)
        complete_frames = sum(complete_emissions(emissions_dir, i, identities[i]) for i in range(len(tracks))
                              if i not in missing)
        if missing:
            try:
                plans = plan_tracks([{"index": i, "audio": tracks[i]["audio"], "duration": tracks[i].get("duration")}
                                     for i in missing], should_stop=should_stop)
            except DecodeCancelled:
                raise Stopped()
            # Decode at its peak, then the missing emissions and the book's concatenated copy of all emissions,
            # all bounded by the probed durations (the request's are not trusted).
            new_emissions = sum(emission_bytes(decoded_samples_bound(plan)) for plan in plans)
            self.reserve(job, session, should_stop,
                         peak_bytes(plans) + new_emissions + complete_frames * 58 + new_emissions)
            job.update(state="decoding")
            decoded = {}

            def on_track(meta):
                session.add_decoded(meta["index"], decoded_dir / meta["pcm"])
                decoded[meta["index"]] = meta
                job.progress(tracksDecoded=len(tracks) - len(missing) + len(decoded))

            started = time.monotonic()
            try:
                decode_tracks([plan["track"] for plan in plans], decoded_dir, should_stop=should_stop,
                              on_track=on_track, plans=plans)
            except DecodeCancelled:
                raise Stopped()
            job.timing("decode", time.monotonic() - started)
            # The decoded audio is on disk now: the emissions still to come, exactly.
            new_emissions = sum(emission_bytes(decoded[i]["samples"]) for i in missing)
            self.reserve(job, session, should_stop, new_emissions + complete_frames * 58 + new_emissions)
            job.update(state="encoding")
            work = [{"index": i, "pcm": str(decoded_dir / decoded[i]["pcm"]), "samples": decoded[i]["samples"],
                     "decode": decoded[i], "identity": identities[i]} for i in missing]
            done_samples = sum(int((read_json(emission_paths(emissions_dir, i)[1]) or {}).get("samples") or 0)
                               for i in range(len(tracks)) if i not in missing)
            on_progress = encode_progress(job, done_samples, work)
            queue = encode_queue(self.device)
            waited = time.monotonic()
            encoded = {"count": len(tracks) - len(missing)}

            def on_encoded(info):
                session.drop_decoded(info["index"])
                encoded["count"] += 1
                job.progress(tracksEncoded=encoded["count"])

            try:
                with queue.hold(job.key, should_stop):
                    job.timing("encodeQueue", time.monotonic() - waited)
                    gate = self.admission
                    # The first load of the resident model holds the lock the window endpoints load it
                    # under (ctc_acoustic.resident_model), so it is a unit of background work like a
                    # batch: it starts only when no window request runs or waits, and a window request
                    # that arrives meanwhile waits at the gate, with its bound, not on the model lock.
                    if gate is None:
                        model = self.model_loader()
                    else:
                        try:
                            with gate.hold_background(should_stop, on_wait=job.gate_wait):
                                model = self.model_loader()
                        except GateWaitStopped:
                            raise EncodeCancelled()
                    monitor = self.gpu_monitor() if self.gpu_monitor else None
                    if monitor is not None:
                        monitor.start()
                    try:
                        stats = encode_tracks(model, work, emissions_dir, None, should_stop=should_stop,
                                              on_track=on_encoded, on_progress=on_progress,
                                              admit=None if gate is None else lambda: gate.hold_background(
                                                  should_stop, on_wait=job.gate_wait))
                    finally:
                        if monitor is not None:
                            monitor.stop()
                    job.timing("encode", stats["encodeSeconds"])
                    job.update(encode={**stats, "gpuUtilization": monitor.mean() if monitor is not None else None})
            except EncodeCancelled:
                raise Stopped()
        metas = []
        for index in range(len(tracks)):
            _, meta_path = emission_paths(emissions_dir, index)
            info = read_json(meta_path)
            if info is None or complete_emissions(emissions_dir, index, identities[index]) is None:
                raise RuntimeError(f"Track {index} has no complete emissions.")
            metas.append(info)
        return metas

    def align(self, job, session, metas, should_stop):
        import numpy as np
        import book_align
        import book_match
        from book_encode import CLASSES, emission_paths
        sentences = [s["text"] for s in job.request["sentences"]]
        groups_dir = job.folder / "groups"
        groups_dir.mkdir(parents=True, exist_ok=True)
        emissions_dir = job.folder / "emissions"
        book_path = emissions_dir / "book.f16"
        book_meta = emissions_dir / "book.json"
        started = time.monotonic()
        frames_total = sum(m["frames"] for m in metas)
        key = emissions_key(metas)
        stored = read_json(book_meta) or {}
        if (stored.get("emissionsKey") != key or not book_path.is_file()
                or book_path.stat().st_size != frames_total * CLASSES * 2):
            # Another set of emissions (a track changed): the old concatenation, plan and groups all go.
            book_meta.unlink(missing_ok=True)
            book_path.unlink(missing_ok=True)
            for stale in groups_dir.glob("*.json"):
                stale.unlink()
            self.reserve(job, session, should_stop, frames_total * CLASSES * 2)
            temporary = emissions_dir / "book.f16.part"
            with temporary.open("wb") as out:
                for meta in metas:
                    data, _ = emission_paths(emissions_dir, meta["index"])
                    with data.open("rb") as source:
                        shutil.copyfileobj(source, out, 1 << 20)
            temporary.replace(book_path)
            write_json(book_meta, {"emissionsKey": key, "frames": frames_total})
        else:
            self.reserve(job, session, should_stop, 0)
        emissions = np.memmap(book_path, dtype=np.float16, mode="r").reshape(-1, CLASSES)
        session.emissions = emissions
        longform = book_align.LongForm(emissions, LABELS, sentences)
        job.timing("prepare", time.monotonic() - started)
        # The text-match check (#403): before any alignment, on this job's emissions.
        started = time.monotonic()
        match = book_match.check(longform.greedy_words, frames_total,
                                 [book_align.text_words(text) for text in sentences], should_stop)
        if match is None:
            raise Stopped()
        job.timing("textMatch", time.monotonic() - started)
        job.progress(textMatch=match)
        if not match["matches"]:
            result = self.result(job, metas, longform, {}, [], match, outcome=book_match.TEXT_MISMATCH)
            with job.lock:
                result["stageTimings"] = dict(job.state.get("stageTimings", {}))
                result["encode"] = job.state.get("encode")
            write_reserved(job, session, job.folder / "result.json", result, should_stop)
            return
        job.update(state="anchoring")
        plan = read_json(groups_dir / "plan.json")
        if plan is None or plan.get("emissionsKey") != key or plan.get("frames") != frames_total:
            started = time.monotonic()
            for stale in groups_dir.glob("*.json"):
                stale.unlink()
            try:
                tasks, info = book_align.plan_groups(longform, should_stop)
            except book_align.Cancelled:
                raise Stopped()
            plan = {"frames": frames_total, "emissionsKey": key, "tasks": tasks, "anchors": info}
            write_json(groups_dir / "plan.json", plan)
            job.timing("anchor", time.monotonic() - started)
        tasks = plan["tasks"]
        done = {t["index"] for t in tasks
                if (read_json(groups_dir / f"{t['index']}.json") or {}).get("emissionsKey") == key}
        job.update(state="aligning")
        job.progress(groupsTotal=len(tasks), groupsDone=len(done), anchors=plan["anchors"])
        todo = [t for t in tasks if t["index"] not in done]
        started = time.monotonic()
        if todo:
            self._align_groups(job, session, longform, book_path, sentences, todo, groups_dir, done, should_stop, key)
        job.timing("align", time.monotonic() - started)
        if should_stop():
            raise Stopped()
        job.update(state="finishing")
        started = time.monotonic()
        outputs, stats = [], book_align.new_stats()
        for task in tasks:
            group = read_json(groups_dir / f"{task['index']}.json")
            outputs.append({int(k): tuple(v) for k, v in group["intervals"].items()})
            for name, value in group["stats"].items():
                stats[name] = stats.get(name, 0) + value
        merged, conflicts = book_align.merge_groups(outputs)
        job.timing("finish", time.monotonic() - started)
        # The leftover pass (#403): unmapped audio against unmapped text; it adds, never changes the chain.
        started = time.monotonic()
        def run_pieces(pieces):
            outputs = {}
            self._in_pool(session, longform, book_path, sentences, pieces, should_stop,
                          book_align.run_piece, book_align.pool_piece,
                          lambda n, task, output: outputs.__setitem__(n, output))
            return [outputs[n] for n in range(len(pieces))]

        try:
            pieces, leftover = book_align.leftover_pass(longform, merged, should_stop, run_pieces=run_pieces)
        except book_align.Cancelled:
            raise Stopped()
        job.timing("leftover", time.monotonic() - started)
        started = time.monotonic()
        result = self.result(job, metas, longform, merged, pieces, match)
        starts = self.book_seconds(metas)
        result["stats"].update({**stats, "orderConflictsDropped": conflicts, "groups": len(tasks),
                                "groupStartsSeconds": [round(starts(t["aStart"]), 3) for t in tasks],
                                "anchors": plan["anchors"], "kernel": book_align.kernel_name(),
                                "rawMapped": len(merged), "device": self.device, "leftover": leftover})
        job.timing("finish", time.monotonic() - started)
        with job.lock:
            result["stageTimings"] = dict(job.state.get("stageTimings", {}))
            result["encode"] = job.state.get("encode")
        write_reserved(job, session, job.folder / "result.json", result, should_stop)

    def _align_groups(self, job, session, longform, book_path, sentences, todo, groups_dir, done, should_stop,
                      key=None):
        import book_align

        def save(_n, task, output):
            intervals, stats, trimmed = output
            write_json(groups_dir / f"{task['index']}.json",
                       {"index": task["index"], "emissionsKey": key,
                        "intervals": {str(k): list(v) for k, v in intervals.items()},
                        "trimmed": {str(k): list(v) for k, v in trimmed.items()}, "stats": stats})
            done.add(task["index"])
            job.progress(groupsDone=len(done))

        self._in_pool(session, longform, book_path, sentences, todo, should_stop, book_align.align_group,
                      book_align.pool_align, save)

    def _in_pool(self, session, longform, book_path, sentences, tasks, should_stop, here, there, on_done):
        """Run `tasks` in the session's process pool (`there(task)` in a process) or, with one worker or one
        task, here (`here(longform, task, should_stop)`); `on_done(n, task, output)` as each finishes."""
        import book_align
        workers = self.align_workers()
        if workers <= 1 or len(tasks) == 1:
            for n, task in enumerate(tasks):
                if should_stop():
                    raise Stopped()
                try:
                    output = here(longform, task, should_stop)
                except book_align.Cancelled:
                    raise Stopped()
                on_done(n, task, output)
            return
        import concurrent.futures
        import multiprocessing
        pool = concurrent.futures.ProcessPoolExecutor(
            max_workers=min(workers, len(tasks)), mp_context=multiprocessing.get_context("spawn"),
            initializer=book_align.pool_init, initargs=(str(book_path), 29, LABELS, sentences, None, os.getpid()))
        futures = {}
        finished_all = False
        try:
            futures = session.start_pool(
                pool, lambda started: {started.submit(there, task): (n, task) for n, task in enumerate(tasks)})
            pending = set(futures)
            while pending:
                if should_stop():
                    raise Stopped()
                finished, pending = concurrent.futures.wait(pending, timeout=0.5,
                                                            return_when=concurrent.futures.FIRST_COMPLETED)
                for future in finished:
                    try:
                        output = future.result()
                    except Exception:
                        if should_stop():  # the session ended and stopped the processes
                            raise Stopped()
                        raise
                    on_done(*futures[future], output)
            finished_all = True
        finally:
            # A stopped or failed job's processes are terminated and waited for, not left to finish their task.
            session.release_pool(pool, stop=not finished_all)

    @staticmethod
    def offsets(metas):
        frame_offsets, sample_offsets = [], []
        frames = samples = 0
        for meta in metas:
            frame_offsets.append(frames)
            sample_offsets.append(samples)
            frames += meta["frames"]
            samples += meta["samples"]
        return frame_offsets, sample_offsets

    def book_seconds(self, metas):
        """Global frame -> book seconds: the frame's own track grid, after the earlier tracks' decoded audio."""
        import bisect
        import book_align
        frame_offsets, sample_offsets = self.offsets(metas)

        def to_seconds(frame):
            t = max(0, bisect.bisect_right(frame_offsets, frame) - 1)
            return (sample_offsets[t] + book_align.frame_boundary(frame - frame_offsets[t])) / book_align.RATE
        return to_seconds

    def result(self, job, metas, longform, merged, pieces, match, outcome=None):
        """Validate the chain's merged intervals and each leftover piece on its own, express them in each
        track's own time, and describe what is left: unsynced passages and flags (book_report)."""
        import bisect
        import book_align
        import book_report
        tracks = job.request["tracks"]
        sentences = job.request["sentences"]
        _, sample_offsets = self.offsets(metas)
        to_seconds = self.book_seconds(metas)
        accepted = book_align.validate(longform, merged, to_seconds) if merged else {}
        chain_mapped = len(accepted)
        for piece in pieces:
            for k, value in book_align.validate(longform, piece, to_seconds).items():
                accepted.setdefault(k, value)  # pieces hold only sentences the chain did not map
        intervals = []
        for k in sorted(accepted):
            start, end = accepted[k]
            t = max(0, bisect.bisect_right(sample_offsets, round(start * book_align.RATE)) - 1)
            offset = sample_offsets[t] / book_align.RATE
            local_end = min(end - offset, metas[t]["samples"] / book_align.RATE)
            local_start = start - offset
            sentence = sentences[k]
            rate = words_in(sentence["text"]) / max(1e-6, local_end - local_start)
            intervals.append({"paragraphId": sentence["id"], "section": sentence.get("section", 0),
                              "trackId": tracks[t]["id"], "start": round(local_start, 4),
                              "end": round(local_end, 4), "confidence": 0.65 if 0.3 < rate < 6 else 0.2})
        track_rows = []
        for meta, track in zip(metas, tracks):
            check = (meta.get("decode") or {}).get("durationCheck") or {}
            track_rows.append({"id": track["id"], "decodedSeconds": meta["samples"] / book_align.RATE,
                               "containerSeconds": check.get("containerSeconds"),
                               "differenceSeconds": check.get("differenceSeconds"), "durationOk": check.get("ok"),
                               "ranges": (meta.get("decode") or {}).get("ranges")})
        titles = book_report.section_titles(job.request.get("sections"))
        mapped_ids = {i["paragraphId"] for i in intervals}
        flags = book_report.flags(sentences, intervals,
                                  [{"id": row["id"], "seconds": row["decodedSeconds"]} for row in track_rows], titles)
        return {"jobId": job.key, "engine": BOOK_ENGINE, "recordingId": job.request.get("recordingId"),
                "audioFingerprint": job.request.get("audioFingerprint"),
                "outcome": outcome or ("mapped" if intervals else "unsynced"), "sentences": len(sentences),
                "mapped": len(intervals), "intervals": intervals,
                "unsyncedPassages": book_report.unsynced_passages(sentences, mapped_ids, titles),
                "flags": flags, "textMatch": match, "tracks": track_rows,
                "stats": {"chainMapped": chain_mapped, "leftoverMapped": len(intervals) - chain_mapped}}
