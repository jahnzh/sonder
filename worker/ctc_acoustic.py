"""Resident, offline Wav2Vec2 Base encoder and its sample-accurate frame grid."""
import hashlib
import math
import os
import threading
from pathlib import Path

SAMPLE_RATE = 16000
STRIDE = 320
RECEPTIVE_FIELD = 400
CORE = 20 * SAMPLE_RATE
CONTEXT = 5 * SAMPLE_RATE
CHECKPOINT = "wav2vec2_fairseq_base_ls960_asr_ls960.pth"
CHECKPOINT_SHA256 = "488fd4f16de84438ffc945334278c1b9fb9b7159a806c1080b16111a958c945d"
# v2: windows partly in the acoustic cache keep their audio in time order.
ENGINE = "ctc-wav2vec2-base-960h-torchaudio-2.8-v2"
# Starting defaults (#276); ALIGNMENT_CTC_ENCODE_BATCH overrides the microbatch.
RESIDENT_MODELS_PER_DEVICE = 1
ACOUSTIC_MICROBATCH = 4


def checkpoint_path(folder):
    return Path(folder) / "models" / "ctc" / CHECKPOINT


def verify_checkpoint(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != CHECKPOINT_SHA256:
        raise ValueError("The CTC checkpoint does not match the pinned model.")


def chunks(samples):
    """Return (core start/end, context start/end), all on the original sample grid."""
    for start in range(0, samples, CORE):
        end = min(samples, start + CORE)
        yield start, end, max(0, start - CONTEXT), min(samples, end + CONTEXT)


def core_frames(core_start, core_end, context_start, valid_length):
    """Select valid encoder frames by their convolution receptive-field centres."""
    centre = RECEPTIVE_FIELD / 2
    first = max(0, math.ceil((core_start - context_start - centre) / STRIDE))
    last = min(valid_length, max(0, math.ceil((core_end - context_start - centre) / STRIDE)))
    return min(first, last), last


def frame_boundary(context_start, frame):
    # Frame centres are (400 / 2) samples from the convolution input start.
    # Boundaries lie half a stride before each centre, rather than scaling by
    # the total duration / number of emitted frames.
    return context_start + frame * STRIDE + (RECEPTIVE_FIELD - STRIDE) // 2


def is_out_of_memory(error):
    """CUDA (torch.cuda.OutOfMemoryError) and CPU allocator failures, without importing torch."""
    if isinstance(error, MemoryError) or type(error).__name__ == "OutOfMemoryError":
        return True
    message = str(error).lower()
    return isinstance(error, RuntimeError) and ("out of memory" in message or "can't allocate memory" in message)


class Microbatch:
    """Acoustic microbatch for one request. An out-of-memory error halves it and retries the same cores."""
    def __init__(self, size, configured=None):
        self.configured = size if configured is None else configured
        self.size = size
        self.halvings = 0

    def encode(self, model, items):
        results = []
        offset = 0
        while offset < len(items):
            group = items[offset:offset + self.size]
            try:
                results.extend(model.encode_chunks(group))
            except Exception as error:
                if not is_out_of_memory(error) or self.size == 1:
                    raise
                model.release_memory()
                self.size = max(1, self.size // 2)
                self.halvings += 1
                continue
            offset += len(group)
        return results

    def report(self):
        return {"acousticMicrobatch": self.configured, "acousticMicrobatchUsed": self.size,
                "oomHalvings": self.halvings}


class AcousticModel:
    def __init__(self, folder):
        import torch
        import torchaudio

        path = checkpoint_path(folder)
        verify_checkpoint(path)
        bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
        # Construct from the pinned bundle and load local bytes directly. In
        # contrast to bundle.get_model(), this cannot download on a cache miss.
        model = torchaudio.models.wav2vec2_model(**bundle._params)
        state = torch.load(path, map_location="cpu", weights_only=True)
        for key in ("aux.weight", "aux.bias"):
            state[key] = torch.stack([row for index, row in enumerate(state[key]) if index not in bundle._remove_aux_axis])
        model.load_state_dict(state)
        self.torch = torch
        self.device = torch.device(os.environ.get("ALIGNMENT_CTC_DEVICE", "cpu"))
        self.dtype = torch.float16 if self.device.type == "cuda" else torch.float32
        self.model = model.eval().to(device=self.device, dtype=self.dtype)
        self.labels = bundle.get_labels()

    def release_memory(self):
        """Return cached CUDA blocks after an out-of-memory error, so the smaller retry can allocate."""
        if self.device.type == "cuda":
            self.torch.cuda.empty_cache()

    def encode_chunk(self, audio, core_start, core_end, context_start):
        """Encode one core using the supplied context on the track sample grid."""
        results = self.encode_chunks([(audio, core_start, core_end, context_start)])
        return results[0]

    def encode_chunks(self, items):
        """Encode many cores in one forward pass; each item is (audio, core_start, core_end, context_start).

        Windows are right-padded to the longest item so the GPU sees one dense batch. Empty batches
        return an empty list. Per-item None means the core produced no valid frames.
        """
        if not items:
            return []
        torch = self.torch
        import numpy as np
        lengths = [len(audio) for audio, *_ in items]
        widest = max(lengths)
        batch = np.zeros((len(items), widest), dtype=np.float32)
        for row, (audio, *_rest) in enumerate(items):
            batch[row, :len(audio)] = audio
        with torch.inference_mode():
            wave = torch.from_numpy(batch).to(device=self.device, dtype=self.dtype)
            length_tensor = torch.tensor(lengths, device=self.device, dtype=torch.int64)
            logits, valid = self.model(wave, length_tensor)
            results = []
            for row, (_audio, core_start, core_end, context_start) in enumerate(items):
                first, last = core_frames(core_start, core_end, context_start, int(valid[row]))
                if first < last:
                    results.append((logits[row:row + 1, first:last].float().log_softmax(-1).contiguous(),
                                    [frame_boundary(context_start, i) for i in range(first, last)]))
                else:
                    results.append((None, []))
            return results

    def encode(self, audio):
        outputs, boundaries = [], []
        items = [(audio[lo:hi], start, end, lo) for start, end, lo, hi in chunks(len(audio))]
        for emission, chunk_boundaries in self.encode_chunks(items):
            if emission is not None:
                outputs.append(emission)
                boundaries.extend(chunk_boundaries)
        if not outputs:
            raise ValueError("Audio is too short for the CTC encoder.")
        return self.torch.cat(outputs, dim=1).contiguous(), boundaries


_model = None
_model_folder = None
_lock = threading.Lock()


def resident_model(folder):
    """One model per worker process; never silently switch checkpoint roots."""
    global _model, _model_folder
    folder = Path(folder).resolve()
    with _lock:
        if _model is None:
            _model = AcousticModel(folder)
            _model_folder = folder
        elif folder != _model_folder:
            raise ValueError("The resident CTC model belongs to another media root.")
        return _model
