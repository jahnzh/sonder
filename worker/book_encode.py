"""One continuous encode of a recording for a whole-book job (#402), and the per-GPU encode queue.

The windows of all tracks (each track on its own sample grid: 20 s cores with 5 s context, as
`ctc_acoustic.chunks`) form one stream; consecutive windows of equal length are batched, so no batch is
padded. Each track's emissions (float16 log-probabilities over the model's 29 labels, frame i of a track
centred at its sample 200 + 320 i) are written to their own file as soon as the track is complete, so a
restart encodes only the tracks that were not finished.

One encode runs on a device at a time: `EncodeQueue` admits jobs in arrival order and the others wait,
reporting their place. The window endpoints (`/align`, `/anchor`, `/anchor-batch`) do not use the queue.
Each batch of the encode also holds one slot of the window endpoints' gate (`admit`, the worker's
`deadline.Gate.hold_background`): a batch starts only when no window request runs or waits, and a window
request that arrives during a batch waits for it (at most one batch, kept short: see CPU_BATCH).
"""
import json
import os
import threading
import time
from contextlib import contextmanager, nullcontext
from pathlib import Path

from ctc_acoustic import chunks, core_frames, is_out_of_memory
from deadline import GateWaitStopped

CLASSES = 29
FRAME_BYTES = CLASSES * 2
# A window request that finds a batch on the device waits for it (deadline.Gate), so a batch stays short.
# Measured on WSL (2026-11-15, 30 s windows, results back on the CPU): 8 windows on the RTX 3070 Ti in
# float16 take 0.13 s; on the CPU in float32 one window takes 0.93 s with 8 threads, 1.3 s with 4 and
# 4.8 s with 1, and 8 windows 12.9 s with 4. So a CPU batch is one window.
DEFAULT_BATCH = 8
CPU_BATCH = 1


class EncodeCancelled(Exception):
    pass


def encode_batch(env=None, device="cuda"):
    """Windows per batch: ALIGNMENT_BOOK_ENCODE_BATCH (1-64), else 8 on a GPU and 1 on the CPU."""
    env = os.environ if env is None else env
    default = CPU_BATCH if str(device).startswith("cpu") else DEFAULT_BATCH
    try:
        value = int(env.get("ALIGNMENT_BOOK_ENCODE_BATCH", str(default)))
    except (TypeError, ValueError):
        return default
    return value if 1 <= value <= 64 else default


class EncodeQueue:
    """First come, first served admission to one device's encoder."""

    def __init__(self):
        # Guards the queue's list only, never held across I/O (wait() releases it); book job threads and
        # status (position) wait on it, no window request does.
        self._condition = threading.Condition()
        self._waiting = []
        self._holder = None

    def position(self, key):
        """0 while `key` holds the encoder, 1.. while it waits, None otherwise."""
        with self._condition:
            if self._holder == key:
                return 0
            return self._waiting.index(key) + 1 if key in self._waiting else None

    @property
    def holder(self):
        return self._holder

    @contextmanager
    def hold(self, key, should_stop=None, poll=0.5):
        with self._condition:
            self._waiting.append(key)
            try:
                while self._holder is not None or self._waiting[0] != key:
                    if should_stop is not None and should_stop():
                        raise EncodeCancelled()
                    self._condition.wait(poll)
                self._holder = key
            finally:
                self._waiting.remove(key)
                self._condition.notify_all()
        try:
            yield
        finally:
            with self._condition:
                self._holder = None
                self._condition.notify_all()


_QUEUES = {}
_QUEUES_LOCK = threading.Lock()  # the dict only; book job threads and status


def encode_queue(device):
    """The queue of one device ("cuda:0", "cpu", ...); one encode at a time per GPU (and per CPU host)."""
    key = str(device)
    if key == "cuda":
        key = "cuda:0"
    with _QUEUES_LOCK:
        return _QUEUES.setdefault(key, EncodeQueue())


def emission_paths(folder, index):
    folder = Path(folder)
    return folder / f"{index}.f16", folder / f"{index}.json"


def complete_emissions(folder, index, identity):
    """Frames of a finished track's emissions with this identity, or None."""
    data, meta = emission_paths(folder, index)
    try:
        info = json.loads(meta.read_text())
        size = data.stat().st_size
    except (OSError, ValueError):
        return None
    if info.get("identity") != identity or info.get("classes") != CLASSES or size != info.get("frames", -1) * FRAME_BYTES:
        return None
    return info["frames"]


def windows(tracks):
    """(track position, core start, core end, context start, context end) for every track in order."""
    for position, track in enumerate(tracks):
        for start, end, lo, hi in chunks(track["samples"]):
            yield position, start, end, lo, hi


def batches(items, size):
    current = []
    for item in items:
        if current and (item[4] - item[3] != current[0][4] - current[0][3] or len(current) == size):
            yield current
            current = []
        current.append(item)
    if current:
        yield current


def thread_stats(stats, count):
    """The torch threads of the CPU batches so far, {min, max, last}, after one more batch of `count`."""
    if stats is None:
        return {"min": count, "max": count, "last": count}
    return {"min": min(stats["min"], count), "max": max(stats["max"], count), "last": count}


def encode_tracks(model, tracks, folder, identity, batch_size=None, should_stop=None, on_track=None,
                  on_progress=None, load_pcm=None, admit=None, threads=None):
    """Encode `tracks` ([{"index", "pcm", "samples"}]) into `folder/<index>.f16` with `<index>.json`.

    `model` is a `ctc_acoustic.AcousticModel` (its `.model`, `.torch`, `.device`, `.dtype`). `admit()`, when
    given, returns the context held around each batch's inference (one gate slot). On the CPU, `threads()`,
    when given, is the torch thread count for the next batch, asked just before it runs (`cpu_share`: the
    cores no other job holds). Returns stats.
    """
    import numpy as np
    from ctc_acoustic import use_cpu_threads
    torch = model.torch
    device_type = getattr(model.device, "type", model.device)
    on_cpu = str(device_type).startswith("cpu")
    used_threads = None
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    batch_size = batch_size or encode_batch(device=device_type)
    load_pcm = load_pcm or (lambda track: np.memmap(track["pcm"], dtype="<i2", mode="r"))
    audio = {}
    handles = {}
    frames = {}
    remaining = {}
    for position, track in enumerate(tracks):
        remaining[position] = sum(1 for _ in chunks(track["samples"]))
    started = time.monotonic()
    encoded_samples = 0
    halvings = 0
    pending = list(batches(windows(tracks), batch_size))
    pending.reverse()

    def finish(position):
        track = tracks[position]
        handle = handles.pop(position, None)
        data, meta = emission_paths(folder, track["index"])
        part = data.with_suffix(".f16.part")
        if handle is None:
            part.write_bytes(b"")
        else:
            handle.close()
        part.replace(data)
        info = {"index": track["index"], "frames": frames.get(position, 0), "classes": CLASSES,
                "identity": track.get("identity", identity), "samples": track["samples"], "decode": track.get("decode")}
        temporary = meta.with_suffix(".json.part")
        temporary.write_text(json.dumps(info))
        temporary.replace(meta)
        audio.pop(position, None)
        if on_track is not None:
            on_track(info)

    try:
        for position, track in enumerate(tracks):
            if remaining[position] == 0:
                finish(position)
        while pending:
            if should_stop is not None and should_stop():
                raise EncodeCancelled()
            group = pending.pop()
            for item in group:
                if item[0] not in audio:
                    audio[item[0]] = load_pcm(tracks[item[0]])
            waves = np.stack([np.asarray(audio[p][lo:hi], dtype=np.float32) / 32768.0
                              for p, _s, _e, lo, hi in group])
            try:
                # The batch's results are on the CPU before the slot is given back.
                with (admit() if admit is not None else nullcontext()), torch.inference_mode():
                    if on_cpu and threads is not None:
                        # Asked once the slot is held, so the count is the one free while the batch runs.
                        count = threads()
                        use_cpu_threads(torch, count)
                        used_threads = thread_stats(used_threads, count)
                    wave = torch.from_numpy(waves).to(device=model.device, dtype=model.dtype)
                    logits, _ = model.model(wave)
                    out = logits.float().log_softmax(-1)
                    valid = out.shape[1]
                    parts = []
                    for row, (p, start, end, lo, _hi) in enumerate(group):
                        first, last = core_frames(start, end, lo, valid)
                        parts.append((p, out[row, first:last].to(torch.float16).cpu().numpy()))
            except GateWaitStopped:
                raise EncodeCancelled()
            except Exception as error:
                if not is_out_of_memory(error) or len(group) == 1:
                    raise
                if model.device.type == "cuda":
                    torch.cuda.empty_cache()
                half = len(group) // 2
                pending.extend([group[half:], group[:half]])
                halvings += 1
                continue
            encoded_samples += waves.size
            for p, chunk in parts:
                if p not in handles:
                    data, _ = emission_paths(folder, tracks[p]["index"])
                    handles[p] = data.with_suffix(".f16.part").open("wb")
                chunk.tofile(handles[p])
                frames[p] = frames.get(p, 0) + len(chunk)
            for p, *_rest in group:
                remaining[p] -= 1
                if remaining[p] == 0:
                    finish(p)
            if on_progress is not None:
                on_progress(group[-1][0], group[-1][2])
    finally:
        for handle in handles.values():
            handle.close()
    elapsed = time.monotonic() - started
    total = sum(track["samples"] for track in tracks)
    return {"encodeSeconds": elapsed, "encodedAudioSeconds": encoded_samples / 16000,
            "audioSeconds": total / 16000, "realtime": (total / 16000 / elapsed) if elapsed else None,
            "batch": batch_size, "oomHalvings": halvings,
            "threads": used_threads}
