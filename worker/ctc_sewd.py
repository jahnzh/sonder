"""SEW-D tiny, the whole-book encoder of CPU hosts (#921): pinned weights, its labels, its frame grid.

`asapp/sew-d-tiny-100k-ft-ls100h` (24 M parameters, Apache-2.0) at a pinned revision, loaded offline from
`MEDIA_ROOT/alignment/models/sew-d-tiny/<revision>/` through transformers' `SEWDForCTC`. The files are fetched
only by `download_model.py` and checked against their SHA-256 here before every load.

The model gives the same emissions the book aligner reads from Wav2Vec2 Base:
* **Labels.** Its characters are mapped to the emissions' 29 classes (`book_job.LABELS`, blank first): the
  blank is its `<pad>` (the CTC blank, `pad_token_id`), `|`, A to Z and the apostrophe are its own; its `<s>`,
  `</s>` and `<unk>` are dropped and the log-softmax is taken over the 29 kept.
* **Frame grid.** Its feature extractor is Wav2Vec2's (seven convolutions, stride 320, receptive field 400) and
  its squeeze is undone before the CTC head, so frame i of a window is centred at sample 200 + 320 i, as Base's.
  `frame_grid` computes both from the checkpoint's config and the load refuses any other; `book_encode` checks
  each batch's frame count, and `book_align.frame_boundary` turns frames into seconds on that grid.
* **Input.** Each window is normalised to zero mean and unit variance, as its feature extractor does
  (`do_normalize`); Base takes the raw waveform.
"""
import hashlib
import os
import threading
from pathlib import Path

REPOSITORY = "asapp/sew-d-tiny-100k-ft-ls100h"
REVISION = "1966cdcfbd2123ee90b003c2aa6ec6fe204cc4d8"
TRANSFORMERS_VERSION = "4.56.2"
# The files the load reads, with their pinned SHA-256 (the safetensors weights are 96.5 MB).
FILES = {
    "config.json": "3867e5943cf39615625d4c70bcb93a9a8be2cd3ba8f7d557e2ff594ac6b3f96d",
    "preprocessor_config.json": "4a93853b74278b7c769d07f5a861e5d12ceb5db2bced5620d335f87238cb9e86",
    "vocab.json": "e8678127b05ad862b6e2f4fb63159b15761059a678b27a0754163fe02d43fa5f",
    "model.safetensors": "a34b13a854712ea576cbd1dcb6eedcfa976138275570873fad83d0e40e73f166",
}
STRIDE = 320
RECEPTIVE_FIELD = 400


def model_folder(alignment_folder):
    return Path(alignment_folder) / "models" / "sew-d-tiny" / REVISION


def file_url(name):
    return f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{name}"


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_file(path, name):
    if sha256(path) != FILES[name]:
        raise ValueError(f"The SEW-D tiny file {name} does not match the pinned model.")


def files_present(alignment_folder):
    """Every pinned file is there (no hashing: `/health` asks this); the load verifies them."""
    folder = model_folder(alignment_folder)
    return all((folder / name).is_file() for name in FILES)


def transformers_ready():
    """transformers at the pinned version is installed (without importing it, which takes seconds)."""
    try:
        from importlib.metadata import PackageNotFoundError, version
        return version("transformers") == TRANSFORMERS_VERSION
    except (ImportError, PackageNotFoundError, ValueError):
        return False


def frame_grid(config):
    """(stride, receptive field) in samples of the convolutional feature extractor described by `config`."""
    kernels, strides = list(config["conv_kernel"]), list(config["conv_stride"])
    if len(kernels) != len(strides) or not kernels:
        raise ValueError("The SEW-D config has no valid feature extractor.")
    stride = 1
    for value in strides:
        stride *= int(value)
    field = int(kernels[-1])
    for kernel, step in zip(reversed(kernels[:-1]), reversed(strides[:-1])):
        field = (field - 1) * int(step) + int(kernel)
    return stride, field


def label_indices(vocab, labels, blank):
    """The model's class index of each of `labels` (blank first: its `blank` token)."""
    indices = []
    for label in labels:
        token = blank if label == labels[0] else label
        if token not in vocab:
            raise ValueError(f"The SEW-D vocabulary has no {token!r}.")
        indices.append(int(vocab[token]))
    if len(set(indices)) != len(indices):
        raise ValueError("The SEW-D vocabulary maps two labels to one class.")
    return indices


class _Labelled:
    """`model(wave)` -> (logits over the emissions' 29 classes, None), the interface `book_encode` calls."""

    def __init__(self, torch, model, keep, normalize):
        self.torch = torch
        self.inner = model
        self.keep = keep
        self.normalize = normalize

    def __call__(self, wave):
        if self.normalize:
            mean = wave.mean(dim=1, keepdim=True)
            variance = wave.float().var(dim=1, keepdim=True, unbiased=False)
            wave = (wave - mean) / (variance + 1e-7).sqrt().to(wave.dtype)
        logits = self.inner(wave).logits
        return logits.index_select(-1, self.keep.to(logits.device)), None


class SewdModel:
    """SEW-D tiny with the attributes `book_encode.encode_tracks` uses: `.model`, `.torch`, `.device`, `.dtype`."""
    # Book encodes set their own threads per batch (cpu_share); this model serves no window request.
    window_threads = None
    # The most torch threads a batch of this model uses (`max_threads`, set at load: the physical cores). On lisa
    # (2026-11-26, 300 s of one book, two rounds) SEW-D tiny encodes 18 to 23x on 10 threads, 19 to 21x on 14 and
    # 15.5x on all 20: hyperthreads slow this small model down, while Base is fastest on all 20 (4.8x against 4.0x).
    max_threads = None

    def __init__(self, alignment_folder, device=None):
        import json
        folder = model_folder(alignment_folder)
        for name in FILES:
            verify_file(folder / name, name)
        config = json.loads((folder / "config.json").read_text())
        if frame_grid(config) != (STRIDE, RECEPTIVE_FIELD):
            raise ValueError(f"SEW-D tiny's frame grid {frame_grid(config)} is not the book aligner's.")
        vocab = json.loads((folder / "vocab.json").read_text())
        preprocessor = json.loads((folder / "preprocessor_config.json").read_text())
        from book_job import LABELS
        indices = label_indices(vocab, LABELS, "<pad>")
        if config.get("pad_token_id") != indices[0]:
            raise ValueError("SEW-D tiny's CTC blank is not its <pad> token.")
        # The weights are local: nothing may be fetched from the hub.
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        import torch
        from transformers import SEWDForCTC
        self.torch = torch
        self.device = torch.device(device or os.environ.get("ALIGNMENT_CTC_DEVICE", "cpu"))
        self.dtype = torch.float16 if self.device.type == "cuda" else torch.float32
        model = SEWDForCTC.from_pretrained(str(folder), local_files_only=True, use_safetensors=True)
        model = model.eval().to(device=self.device, dtype=self.dtype)
        self.parameters = sum(p.numel() for p in model.parameters())
        self.model = _Labelled(torch, model, torch.tensor(indices, dtype=torch.long),
                               bool(preprocessor.get("do_normalize")))
        self.labels = LABELS
        from cpu_share import physical_cores
        self.max_threads = physical_cores() if self.device.type == "cpu" else None

    def release_memory(self):
        if self.device.type == "cuda":
            self.torch.cuda.empty_cache()


_model = None
_model_folder = None
_lock = threading.Lock()


def resident_sewd(alignment_folder):
    """One SEW-D tiny per worker process, loaded on the first book encode."""
    global _model, _model_folder
    folder = Path(alignment_folder).resolve()
    with _lock:
        if _model is None:
            _model = SewdModel(folder)
            _model_folder = folder
        elif folder != _model_folder:
            raise ValueError("The resident SEW-D model belongs to another media root.")
        return _model
