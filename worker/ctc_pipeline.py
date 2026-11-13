"""Chapter CTC alignment with deadline-aware publication and resident inference."""
import json
import multiprocessing as mp
import os
import resource
import threading
import time
from concurrent.futures import ProcessPoolExecutor

import ctc_path
import ctc_candidates
import ctc_prefetch
from ctc_acoustic import (ACOUSTIC_MICROBATCH, CONTEXT, CORE, ENGINE, RESIDENT_MODELS_PER_DEVICE, SAMPLE_RATE, STRIDE,
                          Microbatch, resident_model)
from ctc_cache import AcousticCache, audio_digest, budget_bytes, file_version
from ctc_decode import ensure_decoded, forget_decoded
from deadline import AlignmentFailed, AlignmentTimeout, alignment_limit, run_with_deadline


class ResidentTask:
    """A timed-out CUDA call cannot be killed; keep the worker gate until it ends."""
    def __init__(self, work):
        self.done = threading.Event()
        self.value = None
        self.error = None
        def run():
            try:
                self.value = work()
            except BaseException as error:
                self.error = error
            finally:
                self.done.set()
        threading.Thread(target=run, daemon=True).start()

    def poll(self):
        return 0 if self.done.is_set() else None

    def wait(self):
        self.done.wait()


# Concurrent CTC path decodes (forced-align DP over emissions) in one worker process (#276). The request gate
# admits one request per worker today, so this cap only binds once the gate admits more than one book.
CTC_DECODE_WORKERS = 2
_DECODE_SLOTS = threading.BoundedSemaphore(CTC_DECODE_WORKERS)


def encode_batch_size(env=None):
    env = os.environ if env is None else env
    try:
        value = int(env.get("ALIGNMENT_CTC_ENCODE_BATCH", str(ACOUSTIC_MICROBATCH)))
    except (TypeError, ValueError):
        return ACOUSTIC_MICROBATCH
    return value if 1 <= value <= 64 else ACOUSTIC_MICROBATCH


def request_microbatch(env=None, requested=None):
    """The server sends back a microbatch an earlier out-of-memory error halved; never exceed the configured one."""
    configured = encode_batch_size(env)
    if isinstance(requested, int) and 1 <= requested < configured:
        return Microbatch(requested)
    return Microbatch(configured)


def run_config(microbatch, env=None):
    """Concurrency settings this request ran with; the server stores them on the job."""
    return {**microbatch.report(), "decodeWorkers": CTC_DECODE_WORKERS,
            "extractWorkers": ctc_prefetch.extract_workers(env), "residentModelsPerDevice": RESIDENT_MODELS_PER_DEVICE}


def locate_pool_workers(env=None):
    """CPU workers for parallel candidate search; 0 disables the process pool."""
    env = os.environ if env is None else env
    cpus = os.cpu_count() or 1
    default = min(8, max(1, cpus - 2))
    try:
        value = int(env.get("ALIGNMENT_CTC_LOCATE_WORKERS", str(default)))
    except (TypeError, ValueError):
        value = default
    return value if 0 <= value <= 64 else default


def locate_pool_idle_seconds(env=None):
    """Seconds to keep the locate pool after the last batch; 0 shuts it down immediately."""
    env = os.environ if env is None else env
    try:
        value = float(env.get("ALIGNMENT_CTC_LOCATE_IDLE_SECONDS", "120"))
    except (TypeError, ValueError):
        value = 120.0
    return value if value >= 0 else 120.0


_LOCATE_POOL = None
_LOCATE_POOL_TOKENS = None
_LOCATE_POOL_LOCK = threading.Lock()
_LOCATE_POOL_IDLE_TIMER = None
_LOCATE_POOL_GENERATION = 0


def locate_pool_is_open():
    """True while a shared locate process pool is retained."""
    return _LOCATE_POOL is not None


def _cancel_idle_timer_locked():
    global _LOCATE_POOL_IDLE_TIMER
    if _LOCATE_POOL_IDLE_TIMER is not None:
        _LOCATE_POOL_IDLE_TIMER.cancel()
        _LOCATE_POOL_IDLE_TIMER = None


def _shutdown_locate_pool_locked():
    global _LOCATE_POOL, _LOCATE_POOL_TOKENS, _LOCATE_POOL_GENERATION
    _cancel_idle_timer_locked()
    if _LOCATE_POOL is not None:
        _LOCATE_POOL.shutdown(wait=True, cancel_futures=False)
        _LOCATE_POOL = None
        _LOCATE_POOL_TOKENS = None
        _LOCATE_POOL_GENERATION += 1


def shutdown_locate_pool():
    """Tear down the shared locate pool (worker stop, idle timeout, or idle=0)."""
    with _LOCATE_POOL_LOCK:
        _shutdown_locate_pool_locked()


def _idle_shutdown(generation):
    with _LOCATE_POOL_LOCK:
        if generation != _LOCATE_POOL_GENERATION or _LOCATE_POOL is None:
            return
        _shutdown_locate_pool_locked()


def release_locate_pool(env=None):
    """After a batch request: shut down now (idle=0) or schedule an idle timeout."""
    global _LOCATE_POOL_IDLE_TIMER
    idle = locate_pool_idle_seconds(env)
    with _LOCATE_POOL_LOCK:
        if _LOCATE_POOL is None:
            return
        _cancel_idle_timer_locked()
        if idle <= 0:
            _shutdown_locate_pool_locked()
            return
        generation = _LOCATE_POOL_GENERATION
        timer = threading.Timer(idle, _idle_shutdown, args=(generation,))
        timer.daemon = True
        _LOCATE_POOL_IDLE_TIMER = timer
        timer.start()


def open_locate_pool(fragment_tokens, workers=None, env=None):
    """Process pool with FragmentIndex tokens built once per worker (initializer).

    Call from the request/script thread — never from inside ResidentTask — so spawn
    does not race CUDA work and scripts can use ``if __name__ == '__main__'``.
    Reuses the pool across requests that share the same token list (same book).
    Call ``release_locate_pool`` when the batch request finishes.
    """
    global _LOCATE_POOL, _LOCATE_POOL_TOKENS, _LOCATE_POOL_GENERATION
    workers = locate_pool_workers(env) if workers is None else workers
    if workers <= 0:
        return None
    with _LOCATE_POOL_LOCK:
        _cancel_idle_timer_locked()
        if _LOCATE_POOL is not None and _LOCATE_POOL_TOKENS == fragment_tokens:
            return _LOCATE_POOL
        if _LOCATE_POOL is not None:
            _LOCATE_POOL.shutdown(wait=False, cancel_futures=True)
            _LOCATE_POOL = None
            _LOCATE_POOL_TOKENS = None
            _LOCATE_POOL_GENERATION += 1
        _LOCATE_POOL_TOKENS = fragment_tokens
        _LOCATE_POOL = ProcessPoolExecutor(
            max_workers=workers,
            mp_context=mp.get_context("spawn"),
            initializer=ctc_candidates._pool_init,
            initargs=(fragment_tokens,),
        )
        return _LOCATE_POOL


def _audio_slice(pcm, lo, hi):
    """Read [lo, hi) from a numpy buffer or an on-disk DecodedTrack."""
    if hasattr(pcm, "slice"):
        return pcm.slice(lo, hi)
    return pcm[lo:hi]


def _window_cores(first_sample, end_sample, total_samples):
    """Yield (core_start, core_end, context_start, context_end) for cores covering a window."""
    for index in range(first_sample // CORE, (end_sample + CORE - 1) // CORE):
        core_start = index * CORE
        core_end = min(core_start + CORE, total_samples)
        context_start = max(0, core_start - CONTEXT)
        context_end = min(core_start + CORE + CONTEXT, total_samples)
        yield index, core_start, core_end, context_start, context_end


def _infer_from_pcm(pcm, folder, fragments, start, duration, source, source_version,
                    recording_id, recording_fingerprint, track_id, env, locate=False,
                    digest=None, index=None, model=None, microbatch=None):
    """Encode one window from a decoded track PCM buffer. Digest/model/index may be shared."""
    identity_started = time.monotonic()
    if digest is None:
        digest, version = audio_digest(source)
        if version != source_version:
            raise ValueError("Audio changed during extraction.")
    cache = AcousticCache(folder, recording_id or str(source), ENGINE,
                          recording_fingerprint or "direct", [track_id or str(source), digest],
                          budget_bytes(env))
    model_started = time.monotonic()
    model = model or resident_model(folder)
    loaded = time.monotonic()
    first_sample = round(start * SAMPLE_RATE)
    end_sample = min(round((start + duration) * SAMPLE_RATE), len(pcm))
    outputs, boundaries = [], []
    encoding_seconds = cache_seconds = cache_write_seconds = 0.0
    pending = []
    microbatch = microbatch or Microbatch(encode_batch_size(env))

    def flush():
        nonlocal encoding_seconds, cache_write_seconds
        if not pending:
            return
        encode_started = time.monotonic()
        encoded = microbatch.encode(model, [(item["audio"], item["core_start"], item["core_end"], item["context_start"])
                                            for item in pending])
        if model.device.type == "cuda":
            model.torch.cuda.synchronize()
        encoding_seconds += time.monotonic() - encode_started
        for item, (emission, chunk_boundaries) in zip(pending, encoded):
            if emission is None:
                continue
            if cache.budget:
                cache_started = time.monotonic()
                data = emission.detach().to(device="cpu", dtype=model.torch.float32).contiguous().numpy().astype("<f4", copy=False).tobytes()
                cache.write(item["index"], chunk_boundaries[0], len(chunk_boundaries), len(model.labels), data)
                cache_write_seconds += time.monotonic() - cache_started
            _select(item["first_sample"], item["end_sample"], emission, chunk_boundaries, outputs, boundaries)
        pending.clear()

    def _select(first, end, emission, chunk_boundaries, outs, bounds):
        selected = [i for i, boundary in enumerate(chunk_boundaries)
                    if first <= boundary + STRIDE // 2 < end]
        if selected:
            outs.append(emission[:, selected[0]:selected[-1] + 1])
            bounds.extend(chunk_boundaries[i] - first for i in selected)

    for core_index, core_start, core_end, context_start, context_end in _window_cores(first_sample, end_sample, len(pcm)):
        cache_started = time.monotonic()
        chunk = cache.read(core_index, len(model.labels))
        cache_seconds += time.monotonic() - cache_started
        if chunk is None:
            pending.append({
                "index": core_index, "audio": _audio_slice(pcm, context_start, context_end),
                "core_start": core_start, "core_end": core_end, "context_start": context_start,
                "first_sample": first_sample, "end_sample": end_sample,
            })
            if len(pending) >= microbatch.size:
                flush()
        else:
            cache_started = time.monotonic()
            first, frames, data = chunk
            import numpy as np
            chunk_boundaries = [first + i * STRIDE for i in range(frames)]
            emission = model.torch.from_numpy(np.frombuffer(data, dtype="<f4").copy().reshape(1, frames, len(model.labels))).to(model.device)
            cache_seconds += time.monotonic() - cache_started
            _select(first_sample, end_sample, emission, chunk_boundaries, outputs, boundaries)
    flush()
    if not outputs:
        raise ValueError("Audio is too short for the CTC encoder.")
    emissions = model.torch.cat(outputs, dim=1).contiguous()
    encoded = time.monotonic()
    with _DECODE_SLOTS:
        result = (ctc_candidates.locate(emissions, boundaries, fragments, model.labels, first_sample, index=index)
                  if locate else ctc_path.align(emissions, boundaries, fragments, model.labels, end_sample - first_sample,
                                                first_sample, model.torch))
    if model.device.type == "cuda":
        model.torch.cuda.synchronize()
    return result, {"acousticCacheKey": model_started - identity_started,
                       "modelReady": loaded - model_started, "acousticEncoding": encoding_seconds,
                       "acousticCacheRead": cache_seconds, "acousticCacheWrite": cache_write_seconds,
                       "ctcPath": time.monotonic() - encoded}


def _infer(wave_path, folder, fragments, start, duration, wave_start, source, source_version,
           recording_id, recording_fingerprint, track_id, env, locate=False, microbatch=None):
    try:
        import numpy as np
        import wave
        with wave.open(str(wave_path), "rb") as audio_file:
            if (audio_file.getnchannels(), audio_file.getsampwidth(), audio_file.getframerate()) != (1, 2, SAMPLE_RATE):
                raise ValueError("Expected mono 16-bit PCM at 16 kHz.")
            window = np.frombuffer(audio_file.readframes(audio_file.getnframes()), dtype="<i2").astype("float32") / 32768.0
        # Rebuild a track-aligned buffer so core indices match the recording-level cache.
        total = wave_start + len(window)
        pcm = np.zeros(total, dtype="float32")
        pcm[wave_start:] = window
        return _infer_from_pcm(pcm, folder, fragments, start, duration, source, source_version,
                               recording_id, recording_fingerprint, track_id, env, locate=locate,
                               microbatch=microbatch)
    finally:
        wave_path.unlink(missing_ok=True)


def align_ctc_section(*, audio, output, fragments, language, start, duration, media_folder, env=None, ffmpeg="ffmpeg",
                      recording_id=None, recording_fingerprint=None, track_id=None, locate=False, microbatch=None):
    limit = alignment_limit(duration, env)
    started = time.monotonic()
    deadline = started + limit
    output.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ if env is None else env
    batch = request_microbatch(env, microbatch)
    # Single-window /anchor keeps a section extract so it stays inside the server's
    # 180 s speech-recovery wait. Full-track decode lives on /anchor-batch instead.
    wave_path = output.with_suffix(".ctc.wav")
    wave_start, wave_end = ctc_prefetch.section_window(start, duration)
    source_version = file_version(audio)
    # A window the server named in an earlier request is usually decoded already (worker/ctc_prefetch.py).
    prefetched = ctc_prefetch.take(audio, start, duration, wave_path, deadline)
    try:
        if not prefetched:
            code, error = run_with_deadline(ctc_prefetch.ffmpeg_command(ffmpeg, audio, wave_start, wave_end, wave_path),
                                            deadline, limit)
            if code:
                raise AlignmentFailed(error or f"ffmpeg exited with {code}")
    except BaseException:
        wave_path.unlink(missing_ok=True)
        raise
    extracted = time.monotonic()

    def infer():
        arguments = (wave_path, media_folder, fragments, start, duration, wave_start, audio,
                     source_version, recording_id, recording_fingerprint, track_id, env)
        return _infer(*arguments, locate, batch)

    task = ResidentTask(infer)
    if not task.done.wait(max(0, deadline - time.monotonic())):
        raise AlignmentTimeout(limit, stuck=task)
    if task.error:
        raise task.error
    value, timings = task.value
    finished = time.monotonic()
    if locate:
        outcome = "mapped" if value["match"] else "unsynced"
    else:
        mapped = len({item["index"] for item in value})
        outcome = "mapped" if mapped == len(fragments) else "partial" if mapped else "unsynced"
    result = {"engine": ENGINE, "outcome": outcome,
              "stageTimings": {"audioExtraction": extracted - started, "extractionPrefetched": 1.0 if prefetched else 0.0, **timings},
              "elapsedSeconds": finished - started, "peakMemoryMB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
              "runConfig": run_config(batch, env)}
    if locate:
        result.update(value)
    else:
        result.update({"intervals": value, "quality": None})
    temporary = output.with_suffix(".part")
    try:
        temporary.write_text(json.dumps(result))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return result


def align_ctc_batch_locate(*, audio, output, fragments, language, windows, media_folder, env=None, ffmpeg="ffmpeg",
                           recording_id=None, recording_fingerprint=None, track_id=None, microbatch=None):
    """Locate many sample windows on one track: decode/hash/index once, encode in GPU batches."""
    if not windows:
        raise ValueError("At least one window is required.")
    env = os.environ if env is None else env
    # One batch covers a whole track's samples and a full-track decode; use the chapter ceiling
    # (alignment_limit of a long duration clamps to ALIGNMENT_TIMEOUT_MAX_SECONDS).
    window_budget = alignment_limit(sum(float(window["duration"]) for window in windows), env)
    limit = max(window_budget, alignment_limit(7200, env))
    started = time.monotonic()
    deadline = started + limit
    output.parent.mkdir(parents=True, exist_ok=True)
    microbatch = request_microbatch(env, microbatch)

    # Index + process pool on the calling thread (not ResidentTask): workers build the token
    # list once in the initializer; locate jobs stay ordered via plan_i futures.
    index_started = time.monotonic()
    index = ctc_candidates.FragmentIndex(fragments)
    index_seconds = time.monotonic() - index_started
    workers = locate_pool_workers(env)
    pool = open_locate_pool(index.fragment_tokens, workers=workers, env=env) if workers > 0 and len(windows) > 1 else None

    decoded_track = None

    def work():
        nonlocal decoded_track
        pcm, source_version, extraction, hit = ensure_decoded(
            audio, media_folder, deadline, limit, ffmpeg=ffmpeg, env=env)
        decoded_track = pcm
        digest_started = time.monotonic()
        digest, version = audio_digest(audio)
        if version != source_version:
            raise ValueError("Audio changed during extraction.")
        digest_seconds = time.monotonic() - digest_started
        model_started = time.monotonic()
        model = resident_model(media_folder)
        model_seconds = time.monotonic() - model_started
        cache = AcousticCache(media_folder, recording_id or str(audio), ENGINE,
                              recording_fingerprint or "direct", [track_id or str(audio), digest],
                              budget_bytes(env))
        # Collect every missing core across all windows, encode in large batches, then locate.
        needed = {}
        plans = []
        for window in windows:
            start = float(window["start"])
            duration = float(window["duration"])
            first_sample = round(start * SAMPLE_RATE)
            end_sample = min(round((start + duration) * SAMPLE_RATE), len(pcm))
            cores = []
            for index_id, core_start, core_end, context_start, context_end in _window_cores(first_sample, end_sample, len(pcm)):
                cores.append(index_id)
                if index_id not in needed:
                    needed[index_id] = {
                        "audio": _audio_slice(pcm, context_start, context_end),
                        "core_start": core_start, "core_end": core_end, "context_start": context_start,
                    }
            plans.append({"start": start, "duration": duration, "first_sample": first_sample,
                          "end_sample": end_sample, "cores": cores})
        batch = microbatch.configured
        encoding_seconds = cache_read = cache_write = 0.0
        # Store CPU paths per core so locate can run off-GPU without holding tensors.
        paths_by_core = {}
        missing = []
        for index_id, spec in needed.items():
            cache_started = time.monotonic()
            chunk = cache.read(index_id, len(model.labels))
            cache_read += time.monotonic() - cache_started
            if chunk is None:
                missing.append((index_id, spec))
            else:
                import numpy as np
                first, frames, data = chunk
                logits = np.frombuffer(data, dtype="<f4").copy().reshape(frames, len(model.labels))
                paths_by_core[index_id] = (logits.argmax(axis=-1).tolist(),
                                           [first + i * STRIDE for i in range(frames)])

        labels = tuple(model.labels)
        fragment_tokens = index.fragment_tokens

        def window_job(plan):
            path, boundaries = [], []
            for index_id in plan["cores"]:
                piece = paths_by_core.get(index_id)
                if not piece:
                    continue
                core_path, chunk_boundaries = piece
                selected = [i for i, boundary in enumerate(chunk_boundaries)
                            if plan["first_sample"] <= boundary + STRIDE // 2 < plan["end_sample"]]
                if selected:
                    path.extend(core_path[i] for i in selected)
                    boundaries.extend(chunk_boundaries[i] - plan["first_sample"] for i in selected)
            if not path:
                return None
            return (path, boundaries, labels, plan["first_sample"])

        def finish_ready(pending_plans, futures):
            """Submit locate for windows whose cores are all present; overlap with next encode."""
            still = []
            for plan_i, plan in pending_plans:
                if any(core not in paths_by_core for core in plan["cores"]):
                    still.append((plan_i, plan))
                    continue
                job = window_job(plan)
                if job is None:
                    futures[plan_i] = None
                elif pool is None:
                    futures[plan_i] = ctc_candidates.locate_from_path(
                        job[0], job[1], job[2], job[3], fragment_tokens=fragment_tokens)
                else:
                    futures[plan_i] = pool.submit(ctc_candidates._pool_locate, job)
            return still

        pipeline_started = time.monotonic()
        pending_plans = list(enumerate(plans))
        futures = {}
        locate_wait = 0.0
        # Seed locate for windows already satisfied by the acoustic cache.
        pending_plans = finish_ready(pending_plans, futures)
        for offset in range(0, len(missing), batch):
            group = missing[offset:offset + batch]
            encode_started = time.monotonic()
            encoded = microbatch.encode(model, [(spec["audio"], spec["core_start"], spec["core_end"], spec["context_start"])
                                                for _index_id, spec in group])
            if model.device.type == "cuda":
                model.torch.cuda.synchronize()
            encoding_seconds += time.monotonic() - encode_started
            for (index_id, _spec), (emission, chunk_boundaries) in zip(group, encoded):
                if emission is None:
                    continue
                if cache.budget:
                    cache_started = time.monotonic()
                    data = emission.detach().to(device="cpu", dtype=model.torch.float32).contiguous().numpy().astype("<f4", copy=False).tobytes()
                    cache.write(index_id, chunk_boundaries[0], len(chunk_boundaries), len(model.labels), data)
                    cache_write += time.monotonic() - cache_started
                paths_by_core[index_id] = (
                    emission.argmax(dim=-1)[0].detach().cpu().tolist(),
                    chunk_boundaries,
                )
            # Candidate search for newly completed windows overlaps the next encode batch.
            pending_plans = finish_ready(pending_plans, futures)
        pending_plans = finish_ready(pending_plans, futures)
        results = [None] * len(plans)
        for plan_i, plan in enumerate(plans):
            located = futures.get(plan_i)
            if hasattr(located, "result"):
                waited = time.monotonic()
                located = located.result()
                locate_wait += time.monotonic() - waited
            if located is None:
                results[plan_i] = {"engine": ENGINE, "outcome": "unsynced", "match": None,
                                   "matches": [], "text": "", "start": plan["start"]}
            else:
                outcome = "mapped" if located["match"] else "unsynced"
                results[plan_i] = {"engine": ENGINE, "outcome": outcome, **located}
        if model.device.type == "cuda":
            model.torch.cuda.synchronize()
        pipeline_seconds = time.monotonic() - pipeline_started
        timings = {
            "audioExtraction": extraction,
            "acousticCacheKey": digest_seconds,
            "modelReady": model_seconds,
            "fragmentIndex": index_seconds,
            "acousticEncoding": encoding_seconds,
            "acousticCacheRead": cache_read,
            "acousticCacheWrite": cache_write,
            # Wall of the pipelined encode+locate section minus pure encode: locate and overlap slack.
            "ctcPath": max(0.0, pipeline_seconds - encoding_seconds) if pool is not None else locate_wait or (pipeline_seconds - encoding_seconds),
            "locateWait": locate_wait,
            "decodedTrackHit": 1.0 if hit else 0.0,
            "locateWorkers": float(workers if pool is not None else 0),
        }
        return results, timings

    try:
        task = ResidentTask(work)
        if not task.done.wait(max(0, deadline - time.monotonic())):
            raise AlignmentTimeout(limit, stuck=task)
        if task.error:
            raise task.error
        results, timings = task.value
    finally:
        # Idle=0 tears the pool down per request; otherwise an idle timer frees Xenocide-sized indexes.
        if pool is not None:
            release_locate_pool(env)
        # PCM is no longer needed once acoustic cores are written; drop the multi-GB WAV.
        if decoded_track is not None:
            forget_decoded(decoded_track, media_folder=media_folder, env=env)

    finished = time.monotonic()
    payload = {
        "engine": ENGINE,
        "outcome": "mapped" if any(item.get("match") for item in results) else "unsynced",
        "stageTimings": timings,
        "elapsedSeconds": finished - started,
        "peakMemoryMB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
        "runConfig": run_config(microbatch, env),
        "results": results,
    }
    temporary = output.with_suffix(".part")
    try:
        temporary.write_text(json.dumps(payload))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return payload
