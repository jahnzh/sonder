"""Chapter CTC alignment with deadline-aware publication and resident inference."""
import json
import resource
import threading
import time
import wave

import ctc_path
from ctc_acoustic import ENGINE, SAMPLE_RATE, resident_model
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


def _infer(wave_path, folder, fragments, start):
    try:
        import numpy as np
        with wave.open(str(wave_path), "rb") as audio_file:
            if (audio_file.getnchannels(), audio_file.getsampwidth(), audio_file.getframerate()) != (1, 2, SAMPLE_RATE):
                raise ValueError("Expected mono 16-bit PCM at 16 kHz.")
            audio = np.frombuffer(audio_file.readframes(audio_file.getnframes()), dtype="<i2").astype("float32") / 32768.0
        model_started = time.monotonic()
        model = resident_model(folder)
        loaded = time.monotonic()
        emissions, boundaries = model.encode(audio)
        if model.device.type == "cuda":
            model.torch.cuda.synchronize()
        encoded = time.monotonic()
        intervals = ctc_path.align(emissions, boundaries, fragments, model.labels, len(audio),
                                   round(start * SAMPLE_RATE), model.torch)
        if model.device.type == "cuda":
            model.torch.cuda.synchronize()
        return intervals, {"modelReady": loaded - model_started, "acousticEncoding": encoded - loaded,
                           "ctcPath": time.monotonic() - encoded}
    finally:
        wave_path.unlink(missing_ok=True)


def align_ctc_section(*, audio, output, fragments, language, start, duration, media_folder, env=None, ffmpeg="ffmpeg"):
    limit = alignment_limit(duration, env)
    started = time.monotonic()
    deadline = started + limit
    output.parent.mkdir(parents=True, exist_ok=True)
    wave_path = output.with_suffix(".ctc.wav")
    try:
        code, error = run_with_deadline([ffmpeg, "-nostdin", "-v", "error", "-threads", "1", "-ss", str(start),
                                         "-i", str(audio), "-t", str(duration), "-ac", "1", "-ar", str(SAMPLE_RATE),
                                         "-y", str(wave_path)], deadline, limit)
        if code:
            raise AlignmentFailed(error or f"ffmpeg exited with {code}")
    except BaseException:
        wave_path.unlink(missing_ok=True)
        raise
    extracted = time.monotonic()
    task = ResidentTask(lambda: _infer(wave_path, media_folder, fragments, start))
    if not task.done.wait(max(0, deadline - time.monotonic())):
        raise AlignmentTimeout(limit, stuck=task)
    if task.error:
        raise task.error
    intervals, timings = task.value
    finished = time.monotonic()
    mapped = len({item["index"] for item in intervals})
    outcome = "mapped" if mapped == len(fragments) else "partial" if mapped else "unsynced"
    result = {"engine": ENGINE, "outcome": outcome,
              "stageTimings": {"audioExtraction": extracted - started, **timings},
              "elapsedSeconds": finished - started, "peakMemoryMB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
              "intervals": intervals, "quality": None}
    temporary = output.with_suffix(".part")
    try:
        temporary.write_text(json.dumps(result))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return result
