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
from ctc_acoustic import CONTEXT, CORE, ENGINE, SAMPLE_RATE, STRIDE, resident_model
from ctc_cache import AcousticCache, audio_digest, budget_bytes, file_version
from ctc_decode import ensure_decoded
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


def encode_batch_size(env=None):
    env = os.environ if env is None else env
    try:
        value = int(env.get("ALIGNMENT_CTC_ENCODE_BATCH", "8"))
    except (TypeError, ValueError):
        return 8
    return value if 1 <= value <= 64 else 8


def locate_pool_workers(env=None):
    """CPU workers for parallel candidate search; 0 disables the process pool."""
    env = os.environ if env is None else env
    cpus = os.cpu_count() or 1
    try:
        value = int(env.get("ALIGNMENT_CTC_LOCATE_WORKERS", str(min(16, cpus))))
    except (TypeError, ValueError):
        value = min(16, cpus)
    return value if 0 <= value <= 64 else min(16, cpus)


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
                    digest=None, index=None, model=None):
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
    batch = encode_batch_size(env)

    def flush():
        nonlocal encoding_seconds, cache_write_seconds
        if not pending:
            return
        encode_started = time.monotonic()
        encoded = model.encode_chunks([(item["audio"], item["core_start"], item["core_end"], item["context_start"])
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
            if len(pending) >= batch:
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
           recording_id, recording_fingerprint, track_id, env, locate=False):
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
                               recording_id, recording_fingerprint, track_id, env, locate=locate)
    finally:
        wave_path.unlink(missing_ok=True)


def align_ctc_section(*, audio, output, fragments, language, start, duration, media_folder, env=None, ffmpeg="ffmpeg",
                      recording_id=None, recording_fingerprint=None, track_id=None, locate=False):
    limit = alignment_limit(duration, env)
    started = time.monotonic()
    deadline = started + limit
    output.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ if env is None else env
    # Single-window /anchor keeps a section extract so it stays inside the server's
    # 180 s speech-recovery wait. Full-track decode lives on /anchor-batch instead.
    wave_path = output.with_suffix(".ctc.wav")
    first_sample = round(start * SAMPLE_RATE)
    last_sample = round((start + duration) * SAMPLE_RATE)
    wave_start = max(0, (first_sample // CORE) * CORE - CONTEXT)
    wave_end = ((last_sample + CORE - 1) // CORE) * CORE + CONTEXT
    source_version = file_version(audio)
    try:
        code, error = run_with_deadline([ffmpeg, "-nostdin", "-v", "error", "-threads", "1", "-ss", str(wave_start / SAMPLE_RATE),
                                         "-i", str(audio), "-t", str((wave_end - wave_start) / SAMPLE_RATE), "-ac", "1", "-ar", str(SAMPLE_RATE),
                                         "-y", str(wave_path)], deadline, limit)
        if code:
            raise AlignmentFailed(error or f"ffmpeg exited with {code}")
    except BaseException:
        wave_path.unlink(missing_ok=True)
        raise
    extracted = time.monotonic()

    def infer():
        arguments = (wave_path, media_folder, fragments, start, duration, wave_start, audio,
                     source_version, recording_id, recording_fingerprint, track_id, env)
        return _infer(*arguments, locate=True) if locate else _infer(*arguments)

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
              "stageTimings": {"audioExtraction": extracted - started, **timings},
              "elapsedSeconds": finished - started, "peakMemoryMB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024}
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
                           recording_id=None, recording_fingerprint=None, track_id=None):
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

    def work():
        pcm, source_version, extraction, hit = ensure_decoded(audio, media_folder, deadline, limit, ffmpeg=ffmpeg)
        digest_started = time.monotonic()
        digest, version = audio_digest(audio)
        if version != source_version:
            raise ValueError("Audio changed during extraction.")
        digest_seconds = time.monotonic() - digest_started
        model_started = time.monotonic()
        model = resident_model(media_folder)
        model_seconds = time.monotonic() - model_started
        index_started = time.monotonic()
        index = ctc_candidates.FragmentIndex(fragments)
        index_seconds = time.monotonic() - index_started
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
        batch = encode_batch_size(env)
        workers = locate_pool_workers(env)
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

        def finish_ready(pending_plans, futures, pool):
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
                        job[0], job[1], job[2], job[3], fragment_tokens=index.fragment_tokens)
                else:
                    futures[plan_i] = pool.submit(ctc_candidates._pool_locate, job)
            return still

        pipeline_started = time.monotonic()
        pending_plans = list(enumerate(plans))
        futures = {}
        pool = None
        locate_wait = 0.0
        try:
            if workers > 0 and len(plans) > 1:
                # spawn avoids inheriting the parent's CUDA context into locate workers.
                pool = ProcessPoolExecutor(
                    max_workers=workers,
                    mp_context=mp.get_context("spawn"),
                    initializer=ctc_candidates._pool_init,
                    initargs=(index.fragment_tokens,),
                )
            # Seed locate for windows already satisfied by the acoustic cache.
            pending_plans = finish_ready(pending_plans, futures, pool)
            for offset in range(0, len(missing), batch):
                group = missing[offset:offset + batch]
                encode_started = time.monotonic()
                encoded = model.encode_chunks([(spec["audio"], spec["core_start"], spec["core_end"], spec["context_start"])
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
                pending_plans = finish_ready(pending_plans, futures, pool)
            pending_plans = finish_ready(pending_plans, futures, pool)
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
        finally:
            if pool is not None:
                pool.shutdown(wait=True, cancel_futures=False)
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
            "locateWorkers": float(workers),
        }
        return results, timings

    task = ResidentTask(work)
    if not task.done.wait(max(0, deadline - time.monotonic())):
        raise AlignmentTimeout(limit, stuck=task)
    if task.error:
        raise task.error
    results, timings = task.value
    finished = time.monotonic()
    payload = {
        "engine": ENGINE,
        "outcome": "mapped" if any(item.get("match") for item in results) else "unsynced",
        "stageTimings": timings,
        "elapsedSeconds": finished - started,
        "peakMemoryMB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
        "results": results,
    }
    temporary = output.with_suffix(".part")
    try:
        temporary.write_text(json.dumps(payload))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return payload
