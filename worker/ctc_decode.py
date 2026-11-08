"""Decode each track once to 16 kHz mono PCM and slice sample windows from it."""
import os
import threading
import wave
from pathlib import Path

from ctc_acoustic import SAMPLE_RATE
from ctc_cache import file_version
from deadline import AlignmentFailed, run_with_deadline

# Keep a handful of decoded tracks resident; long books stay on disk under MEDIA_ROOT.
_LOCK = threading.Lock()
_CACHE = {}
_CACHE_LIMIT = 4


def decoded_dir(media_folder):
    path = Path(media_folder) / "decoded"
    path.mkdir(parents=True, exist_ok=True)
    return path


def decoded_path(media_folder, version):
    # Version is (dev, ino, size, mtime_ns, ctime_ns); inode+size+mtime identify the bytes.
    key = f"{version[0]}-{version[1]}-{version[2]}-{version[3]}"
    return decoded_dir(media_folder) / f"{key}.wav"


def _load_pcm(path):
    with wave.open(str(path), "rb") as audio_file:
        if (audio_file.getnchannels(), audio_file.getsampwidth(), audio_file.getframerate()) != (1, 2, SAMPLE_RATE):
            raise ValueError("Expected mono 16-bit PCM at 16 kHz.")
        import numpy as np
        return np.frombuffer(audio_file.readframes(audio_file.getnframes()), dtype="<i2").astype("float32") / 32768.0


def ensure_decoded(audio, media_folder, deadline, limit, ffmpeg="ffmpeg"):
    """Return (pcm float32 array, source_version, extraction_seconds, cache_hit)."""
    import time
    audio = Path(audio)
    version = file_version(audio)
    cache_key = (str(audio.resolve()), version)
    started = time.monotonic()
    with _LOCK:
        remembered = _CACHE.get(cache_key)
        if remembered is not None:
            return remembered, version, 0.0, True
        wave_path = decoded_path(media_folder, version)
        if wave_path.is_file() and file_version(wave_path)[2] > 0:
            pcm = _load_pcm(wave_path)
            _remember(cache_key, pcm)
            return pcm, version, time.monotonic() - started, True
    temporary = wave_path.with_suffix(".part.wav")
    try:
        code, error = run_with_deadline(
            [ffmpeg, "-nostdin", "-v", "error", "-threads", "1", "-i", str(audio),
             "-ac", "1", "-ar", str(SAMPLE_RATE), "-y", str(temporary)],
            deadline, limit)
        if code:
            raise AlignmentFailed(error or f"ffmpeg exited with {code}")
        if file_version(audio) != version:
            raise ValueError("Audio changed during full-track decode.")
        temporary.replace(wave_path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    pcm = _load_pcm(wave_path)
    with _LOCK:
        _remember(cache_key, pcm)
    return pcm, version, time.monotonic() - started, False


def _remember(key, pcm):
    if key in _CACHE:
        _CACHE.pop(key, None)
    while len(_CACHE) >= _CACHE_LIMIT:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = pcm


def clear_decoded_cache():
    with _LOCK:
        _CACHE.clear()


def slice_window(pcm, start, duration, context_pad=0):
    """Return (window_pcm, wave_start_sample) covering [start, start+duration) plus pad."""
    first = round(start * SAMPLE_RATE)
    last = round((start + duration) * SAMPLE_RATE)
    wave_start = max(0, first - context_pad)
    wave_end = min(len(pcm), last + context_pad)
    if wave_end <= wave_start:
        raise ValueError("Audio is too short for the requested window.")
    return pcm[wave_start:wave_end], wave_start
