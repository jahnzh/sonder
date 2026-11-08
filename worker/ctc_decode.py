"""Decode each track once to 16 kHz mono PCM and slice sample windows from it."""
import threading
import wave
from pathlib import Path

from ctc_acoustic import SAMPLE_RATE
from ctc_cache import file_version
from deadline import AlignmentFailed, run_with_deadline

# Remember decoded paths by source version; PCM stays on disk under MEDIA_ROOT.
_LOCK = threading.Lock()
_CACHE = {}
_CACHE_LIMIT = 8


class DecodedTrack:
    """On-disk 16 kHz mono PCM with random-access window reads (no whole-book float32)."""

    def __init__(self, path, version):
        self.path = Path(path)
        self.version = version
        with wave.open(str(self.path), "rb") as audio_file:
            if (audio_file.getnchannels(), audio_file.getsampwidth(), audio_file.getframerate()) != (1, 2, SAMPLE_RATE):
                raise ValueError("Expected mono 16-bit PCM at 16 kHz.")
            self.nframes = audio_file.getnframes()

    def __len__(self):
        return self.nframes

    def slice(self, start_sample, end_sample):
        import numpy as np
        start_sample = max(0, int(start_sample))
        end_sample = min(self.nframes, int(end_sample))
        if end_sample <= start_sample:
            raise ValueError("Audio is too short for the requested window.")
        with wave.open(str(self.path), "rb") as audio_file:
            audio_file.setpos(start_sample)
            raw = audio_file.readframes(end_sample - start_sample)
        return np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0


def decoded_dir(media_folder):
    path = Path(media_folder) / "decoded"
    path.mkdir(parents=True, exist_ok=True)
    return path


def decoded_path(media_folder, version):
    key = f"{version[0]}-{version[1]}-{version[2]}-{version[3]}"
    return decoded_dir(media_folder) / f"{key}.wav"


def ensure_decoded(audio, media_folder, deadline, limit, ffmpeg="ffmpeg"):
    """Return (DecodedTrack, source_version, extraction_seconds, cache_hit)."""
    import time
    audio = Path(audio)
    version = file_version(audio)
    cache_key = (str(audio.resolve()), version)
    started = time.monotonic()
    with _LOCK:
        remembered = _CACHE.get(cache_key)
        if remembered is not None and remembered.path.is_file():
            return remembered, version, 0.0, True
        wave_path = decoded_path(media_folder, version)
        if wave_path.is_file() and file_version(wave_path)[2] > 44:
            track = DecodedTrack(wave_path, version)
            _remember(cache_key, track)
            return track, version, time.monotonic() - started, True
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
    track = DecodedTrack(wave_path, version)
    with _LOCK:
        _remember(cache_key, track)
    return track, version, time.monotonic() - started, False


def _remember(key, track):
    if key in _CACHE:
        _CACHE.pop(key, None)
    while len(_CACHE) >= _CACHE_LIMIT:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = track


def clear_decoded_cache():
    with _LOCK:
        _CACHE.clear()
