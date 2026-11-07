"""Chapter CTC alignment with deadline-aware publication and resident inference."""
import json
import os
import resource
import threading
import time
import wave

import ctc_path
import ctc_candidates
from ctc_acoustic import CONTEXT, CORE, ENGINE, SAMPLE_RATE, STRIDE, resident_model
from ctc_cache import AcousticCache, audio_digest, budget_bytes, file_version
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


def _infer(wave_path, folder, fragments, start, duration, wave_start, source, source_version,
           recording_id, recording_fingerprint, track_id, env, locate=False):
    try:
        import numpy as np
        with wave.open(str(wave_path), "rb") as audio_file:
            if (audio_file.getnchannels(), audio_file.getsampwidth(), audio_file.getframerate()) != (1, 2, SAMPLE_RATE):
                raise ValueError("Expected mono 16-bit PCM at 16 kHz.")
            audio = np.frombuffer(audio_file.readframes(audio_file.getnframes()), dtype="<i2").astype("float32") / 32768.0
        identity_started = time.monotonic()
        digest, version = audio_digest(source)
        if version != source_version:
            raise ValueError("Audio changed during extraction.")
        cache = AcousticCache(folder, recording_id or str(source), ENGINE,
                              recording_fingerprint or "direct", [track_id or str(source), digest],
                              budget_bytes(env))
        model_started = time.monotonic()
        model = resident_model(folder)
        loaded = time.monotonic()
        first_sample = round(start * SAMPLE_RATE)
        end_sample = min(round((start + duration) * SAMPLE_RATE), wave_start + len(audio))
        outputs, boundaries = [], []
        encoding_seconds = cache_seconds = cache_write_seconds = 0.0
        for index in range(first_sample // CORE, (end_sample + CORE - 1) // CORE):
            core_start = index * CORE
            core_end = min(core_start + CORE, wave_start + len(audio))
            context_start = max(0, core_start - CONTEXT)
            context_end = min(core_start + CORE + CONTEXT, wave_start + len(audio))
            cache_started = time.monotonic()
            chunk = cache.read(index, len(model.labels))
            cache_seconds += time.monotonic() - cache_started
            if chunk is None:
                encode_started = time.monotonic()
                emission, chunk_boundaries = model.encode_chunk(
                    audio[context_start - wave_start:context_end - wave_start],
                    core_start, core_end, context_start)
                if model.device.type == "cuda":
                    model.torch.cuda.synchronize()
                encoding_seconds += time.monotonic() - encode_started
                if emission is None:
                    continue
                if cache.budget:
                    cache_started = time.monotonic()
                    data = emission.detach().to(device="cpu", dtype=model.torch.float32).contiguous().numpy().astype("<f4", copy=False).tobytes()
                    cache.write(index, chunk_boundaries[0], len(chunk_boundaries), len(model.labels), data)
                    cache_write_seconds += time.monotonic() - cache_started
            else:
                cache_started = time.monotonic()
                first, frames, data = chunk
                chunk_boundaries = [first + i * STRIDE for i in range(frames)]
                emission = model.torch.from_numpy(np.frombuffer(data, dtype="<f4").copy().reshape(1, frames, len(model.labels))).to(model.device)
                cache_seconds += time.monotonic() - cache_started
            # Frames are selected by their receptive-field centres. Keep the
            # original track grid while returning section-relative boundaries.
            selected = [i for i, boundary in enumerate(chunk_boundaries)
                        if first_sample <= boundary + STRIDE // 2 < end_sample]
            if selected:
                outputs.append(emission[:, selected[0]:selected[-1] + 1])
                boundaries.extend(chunk_boundaries[i] - first_sample for i in selected)
        if not outputs:
            raise ValueError("Audio is too short for the CTC encoder.")
        emissions = model.torch.cat(outputs, dim=1).contiguous()
        encoded = time.monotonic()
        result = (ctc_candidates.locate(emissions, boundaries, fragments, model.labels, first_sample)
                  if locate else ctc_path.align(emissions, boundaries, fragments, model.labels, end_sample - first_sample,
                                                first_sample, model.torch))
        if model.device.type == "cuda":
            model.torch.cuda.synchronize()
        return result, {"acousticCacheKey": model_started - identity_started,
                           "modelReady": loaded - model_started, "acousticEncoding": encoding_seconds,
                           "acousticCacheRead": cache_seconds, "acousticCacheWrite": cache_write_seconds,
                           "ctcPath": time.monotonic() - encoded}
    finally:
        wave_path.unlink(missing_ok=True)


def align_ctc_section(*, audio, output, fragments, language, start, duration, media_folder, env=None, ffmpeg="ffmpeg",
                      recording_id=None, recording_fingerprint=None, track_id=None, locate=False):
    limit = alignment_limit(duration, env)
    started = time.monotonic()
    deadline = started + limit
    output.parent.mkdir(parents=True, exist_ok=True)
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
                     source_version, recording_id, recording_fingerprint, track_id,
                     os.environ if env is None else env)
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
