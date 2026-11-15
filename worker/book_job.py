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

from book_session import BudgetExceeded, SessionEnded, SessionRegistry, estimate_bytes

# A new aligner, so a new engine generation (ADR 0016). The window endpoints keep ctc_acoustic.ENGINE.
BOOK_ENGINE = "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v1"
# torchaudio WAV2VEC2_ASR_BASE_960H labels (the emissions' 29 classes, blank first).
LABELS = ("-", "|", "E", "T", "A", "O", "N", "I", "H", "S", "R", "D", "L", "U", "M", "W", "C", "F", "G", "Y",
          "P", "B", "V", "K", "'", "X", "J", "Q", "Z")
JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
TERMINAL = ("done", "failed", "cancelled")
STATES = ("queued", "decoding", "encoding", "anchoring", "aligning", "finishing") + TERMINAL


class JobConflict(Exception):
    """The job id exists with a different request."""


class UnknownJob(Exception):
    pass


class NotReady(Exception):
    """The result was asked for before the job finished."""


class Stopped(Exception):
    """The job thread was told to stop (cancel, idle end or worker stop)."""


def request_digest(request):
    keys = ("recordingId", "audioFingerprint", "language", "sentences", "tracks")
    canonical = json.dumps({k: request.get(k) for k in keys}, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")))
    temporary.replace(path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def words_in(text):
    return len(text.split())


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
        self.lock = threading.Lock()
        self.save_lock = threading.Lock()  # taken before self.lock, never after it
        self.last_request = time.monotonic()

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


class BookJobs:
    """All whole-book jobs of one worker process."""

    def __init__(self, root, stages, registry=None, clock=time.monotonic):
        self.root = Path(root)
        self.stages = stages
        self.registry = registry or SessionRegistry()
        self._clock = clock
        self._lock = threading.Lock()
        self._jobs = {}
        self._closed = False

    # ------------------------------------------------------------ requests

    def start(self, request):
        key = request["jobId"]
        if not JOB_ID.match(key or ""):
            raise ValueError("Invalid job id.")
        digest = request_digest(request)
        with self._lock:
            job = self._jobs.get(key)
            if job is None:
                folder = self.root / key
                stored = read_json(folder / "request.json")
                if stored is not None and request_digest(stored) != digest:
                    raise JobConflict("This job id belongs to another request.")
                job = self._load_or_create(key, folder, request, digest)
                self._jobs[key] = job
            elif job.digest != digest:
                raise JobConflict("This job id belongs to another request.")
            self._touch(job)
            if job.state["state"] not in TERMINAL and (job.thread is None or not job.thread.is_alive()):
                self._launch(job)
        return self.status(key)

    def status(self, key):
        job = self._job(key)
        self._touch(job)
        with job.lock:
            state = json.loads(json.dumps(job.state))
        state.pop("digest", None)
        if state["state"] == "encoding":
            position = self.stages.encode_position(key)
            state.setdefault("progress", {})["encodeQueuePosition"] = position
        return state

    def cancel(self, key):
        job = self._job(key)
        self._stop(job, "cancelled")
        if job.thread is not None and job.thread is not threading.current_thread():
            job.thread.join(timeout=30)
        self.registry.end(key, "cancelled", delete=True)
        if job.state["state"] not in TERMINAL or job.state["state"] == "done":
            job.update(state="cancelled", error=None)
        with self._lock:
            self._jobs.pop(key, None)
        shutil.rmtree(job.folder, ignore_errors=True)
        return {"jobId": key, "engine": BOOK_ENGINE, "state": "cancelled"}

    def result(self, key):
        job = self._job(key)
        self._touch(job)
        if job.state["state"] != "done":
            raise NotReady(job.state["state"])
        result = read_json(job.folder / "result.json")
        if result is None:
            raise NotReady("missing")
        # The session ends on fetch: decoded audio, emissions and the pool go; the small result stays
        # fetchable until the job has been idle for the session's idle time.
        self.registry.end(key, "fetched", delete=True)
        job.update(fetched=True)
        return result

    # ------------------------------------------------------------ lifecycle

    def resume_all(self):
        """Worker start: pick up every job folder; unfinished jobs continue where they stopped."""
        if not self.root.is_dir():
            return []
        resumed = []
        for folder in sorted(p for p in self.root.iterdir() if p.is_dir()):
            request = read_json(folder / "request.json")
            if request is None or not JOB_ID.match(folder.name) or request.get("jobId") != folder.name:
                continue
            with self._lock:
                if folder.name in self._jobs:
                    continue
                job = self._load_or_create(folder.name, folder, request, request_digest(request))
                self._jobs[folder.name] = job
                job.last_request = self._clock()
                if job.state["state"] not in TERMINAL:
                    job.update(resumed=job.state.get("resumed", 0) + 1)
                    self._launch(job)
                    resumed.append(folder.name)
        return resumed

    def sweep(self):
        """End jobs the server has not asked about for the idle time. Returns the keys ended."""
        now = self._clock()
        with self._lock:
            idle = [job for job in self._jobs.values() if now - job.last_request >= self.registry.idle]
        for job in idle:
            self._stop(job, "idle")
            if job.thread is not None:
                job.thread.join(timeout=30)
            self.registry.end(job.key, "idle", delete=True)
            with self._lock:
                self._jobs.pop(job.key, None)
            shutil.rmtree(job.folder, ignore_errors=True)
        return [job.key for job in idle]

    def shutdown(self):
        """Worker stop: stop the threads, release the sessions, keep the folders for resume."""
        with self._lock:
            self._closed = True
            jobs = list(self._jobs.values())
        for job in jobs:
            self._stop(job, "worker stop")
        for job in jobs:
            if job.thread is not None:
                job.thread.join(timeout=30)
        self.registry.close_all()

    def keys(self):
        with self._lock:
            return list(self._jobs)

    # ------------------------------------------------------------ internals

    def _job(self, key):
        with self._lock:
            job = self._jobs.get(key)
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
        if self._closed:
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
                self._finish(job, {"jobId": job.key, "engine": BOOK_ENGINE, "outcome": "language_not_supported",
                                   "intervals": [], "tracks": []})
                return
            self.stages.run(job, session, should_stop)
            if should_stop():
                raise Stopped()
            self._finish(job, read_json(job.folder / "result.json"))
        except (Stopped, SessionEnded) as error:
            reason = job.stop_reason or str(error) or "stopped"
            if reason == "worker stop":
                return  # resumes on the next start
            if job.state["state"] not in TERMINAL:
                job.update(state="cancelled", error=None, stopReason=reason)
        except BudgetExceeded as error:
            job.update(state="failed", error=str(error))
            self.registry.end(job.key, "failed", delete=True)
        except Exception as error:  # noqa: BLE001 - every failure must reach the job state
            if should_stop() and job.stop_reason == "worker stop":
                return
            print(f"[book-job {job.key}] failed: {error!r}", flush=True)
            traceback.print_exc()
            job.update(state="failed", error=str(error) or type(error).__name__)
            self.registry.end(job.key, "failed", delete=True)

    def _finish(self, job, result):
        if result is None:
            raise RuntimeError("The job finished without a result.")
        write_json(job.folder / "result.json", result)
        job.update(state="done", outcome=result.get("outcome"), error=None)


# ------------------------------------------------------------------ the stages on the real worker

class WorkerStages:
    """Decode, encode, anchor, align and finish with the resident model. `model_loader()` returns a
    `ctc_acoustic.AcousticModel`; `encode_queue(device)` returns the device's `book_encode.EncodeQueue`."""

    def __init__(self, media_folder, model_loader, device="cpu", env=None, gpu_monitor=None):
        self.media_folder = Path(media_folder)
        self.model_loader = model_loader
        self.device = device
        self.env = os.environ if env is None else env
        self.gpu_monitor = gpu_monitor

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
        tracks = job.request["tracks"]
        audio_seconds = sum(float(t.get("duration") or 0) for t in tracks)
        job.update(state="queued")
        session.reserve_disk(estimate_bytes(audio_seconds or 3600.0), should_wait=lambda: not should_stop())
        metas = self.decode_and_encode(job, session, should_stop)
        if should_stop():
            raise Stopped()
        self.align(job, session, metas, should_stop)

    def track_identity(self, session, index, track):
        from ctc_cache import audio_digest
        digest = session.digests.get(index)
        if digest is None:
            digest, _version = audio_digest(track["audio"])
            session.digests[index] = digest
        return {"engine": BOOK_ENGINE, "sha256": digest}

    def decode_and_encode(self, job, session, should_stop):
        from book_audio import DecodeCancelled, decode_tracks
        from book_encode import EncodeCancelled, complete_emissions, emission_paths, encode_queue, encode_tracks
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
        if missing:
            job.update(state="decoding")
            decoded = {}

            def on_track(meta):
                session.add_decoded(meta["index"], decoded_dir / meta["pcm"])
                decoded[meta["index"]] = meta
                job.progress(tracksDecoded=len(tracks) - len(missing) + len(decoded))

            started = time.monotonic()
            try:
                decode_tracks([{"index": i, "audio": tracks[i]["audio"], "duration": tracks[i].get("duration")}
                               for i in missing], decoded_dir, should_stop=should_stop, on_track=on_track)
            except DecodeCancelled:
                raise Stopped()
            job.timing("decode", time.monotonic() - started)
            job.update(state="encoding")
            work = [{"index": i, "pcm": str(decoded_dir / decoded[i]["pcm"]), "samples": decoded[i]["samples"],
                     "decode": decoded[i], "identity": identities[i]} for i in missing]
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
                    model = self.model_loader()
                    monitor = self.gpu_monitor() if self.gpu_monitor else None
                    if monitor is not None:
                        monitor.start()
                    try:
                            stats = encode_tracks(model, work, emissions_dir, None, should_stop=should_stop,
                                              on_track=on_encoded)
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
        from book_encode import CLASSES, emission_paths
        sentences = [s["text"] for s in job.request["sentences"]]
        groups_dir = job.folder / "groups"
        groups_dir.mkdir(parents=True, exist_ok=True)
        emissions_dir = job.folder / "emissions"
        book_path = emissions_dir / "book.f16"
        started = time.monotonic()
        frames_total = sum(m["frames"] for m in metas)
        if not book_path.is_file() or book_path.stat().st_size != frames_total * CLASSES * 2:
            temporary = emissions_dir / "book.f16.part"
            with temporary.open("wb") as out:
                for meta in metas:
                    data, _ = emission_paths(emissions_dir, meta["index"])
                    with data.open("rb") as source:
                        shutil.copyfileobj(source, out, 1 << 20)
            temporary.replace(book_path)
        emissions = np.memmap(book_path, dtype=np.float16, mode="r").reshape(-1, CLASSES)
        session.emissions = emissions
        longform = book_align.LongForm(emissions, LABELS, sentences)
        job.timing("prepare", time.monotonic() - started)
        job.update(state="anchoring")
        plan = read_json(groups_dir / "plan.json")
        if plan is None or plan.get("frames") != frames_total:
            started = time.monotonic()
            for stale in groups_dir.glob("*.json"):
                stale.unlink()
            try:
                tasks, info = book_align.plan_groups(longform, should_stop)
            except book_align.Cancelled:
                raise Stopped()
            plan = {"frames": frames_total, "tasks": tasks, "anchors": info}
            write_json(groups_dir / "plan.json", plan)
            job.timing("anchor", time.monotonic() - started)
        tasks = plan["tasks"]
        done = {t["index"] for t in tasks if (groups_dir / f"{t['index']}.json").is_file()}
        job.update(state="aligning")
        job.progress(groupsTotal=len(tasks), groupsDone=len(done), anchors=plan["anchors"])
        todo = [t for t in tasks if t["index"] not in done]
        started = time.monotonic()
        if todo:
            self._align_groups(job, session, longform, book_path, sentences, todo, groups_dir, done, should_stop)
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
        result = self.result(job, metas, longform, merged)
        starts = self.book_seconds(metas)
        result["stats"] = {**stats, "orderConflictsDropped": conflicts, "groups": len(tasks),
                           "groupStartsSeconds": [round(starts(t["aStart"]), 3) for t in tasks],
                           "anchors": plan["anchors"], "kernel": book_align.kernel_name(),
                           "rawMapped": len(merged), "device": self.device}
        job.timing("finish", time.monotonic() - started)
        with job.lock:
            result["stageTimings"] = dict(job.state.get("stageTimings", {}))
            result["encode"] = job.state.get("encode")
        write_json(job.folder / "result.json", result)

    def _align_groups(self, job, session, longform, book_path, sentences, todo, groups_dir, done, should_stop):
        import book_align
        workers = self.align_workers()

        def save(task, intervals, stats, trimmed):
            write_json(groups_dir / f"{task['index']}.json",
                       {"index": task["index"], "intervals": {str(k): list(v) for k, v in intervals.items()},
                        "trimmed": {str(k): list(v) for k, v in trimmed.items()}, "stats": stats})
            done.add(task["index"])
            job.progress(groupsDone=len(done))

        if workers <= 1 or len(todo) == 1:
            for task in todo:
                if should_stop():
                    raise Stopped()
                try:
                    output = book_align.align_group(longform, task, should_stop)
                except book_align.Cancelled:
                    raise Stopped()
                save(task, *output)
            return
        import concurrent.futures
        import multiprocessing
        pool = concurrent.futures.ProcessPoolExecutor(
            max_workers=min(workers, len(todo)), mp_context=multiprocessing.get_context("spawn"),
            initializer=book_align.pool_init, initargs=(str(book_path), 29, LABELS, sentences))
        futures = {}
        session.set_pool(pool)
        try:
            futures = {pool.submit(book_align.pool_align, task): task for task in todo}
            pending = set(futures)
            while pending:
                if should_stop():
                    raise Stopped()
                finished, pending = concurrent.futures.wait(pending, timeout=0.5,
                                                            return_when=concurrent.futures.FIRST_COMPLETED)
                for future in finished:
                    save(futures[future], *future.result())
        finally:
            for future in futures:
                future.cancel()
            pool.shutdown(wait=True, cancel_futures=True)
            session.pool = None

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

    def result(self, job, metas, longform, merged):
        """Validate the merged intervals and express them in each track's own time."""
        import bisect
        import book_align
        tracks = job.request["tracks"]
        sentences = job.request["sentences"]
        _, sample_offsets = self.offsets(metas)
        to_seconds = self.book_seconds(metas)
        accepted = book_align.validate(longform, merged, to_seconds)
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
        return {"jobId": job.key, "engine": BOOK_ENGINE, "recordingId": job.request.get("recordingId"),
                "audioFingerprint": job.request.get("audioFingerprint"),
                "outcome": "mapped" if intervals else "unsynced", "sentences": len(sentences),
                "mapped": len(intervals), "intervals": intervals, "tracks": track_rows}
