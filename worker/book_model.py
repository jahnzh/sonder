"""Which model a whole-book job encodes with on this host (#921), and the book engine that names its maps.

The host chooses (`worker.env`): `ALIGNMENT_BOOK_MODEL` is `wav2vec2-base` or `sew-d-tiny`. Unset, a GPU host
(`ALIGNMENT_CTC_DEVICE` cuda) keeps Wav2Vec2 Base, which does a book in minutes there, and a CPU host takes
SEW-D tiny, which encodes about four times as fast as Base on lisa's CPU. Window requests (`/align`, `/anchor`,
`/anchor-batch`) always use Base (`ctc_acoustic.ENGINE`). Standard library only: `align` reads it at import.
"""
import os

WAV2VEC2_BASE = "wav2vec2-base"
SEW_D_TINY = "sew-d-tiny"
# The whole-book engine of each model (ADR 0006): a map records the one that made it, and the server accepts both.
BOOK_ENGINES = {
    WAV2VEC2_BASE: "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2",
    SEW_D_TINY: "ctc-sew-d-tiny-100k-ft-ls100h-transformers-4.56-book-v2",
}


def book_model_name(env=None):
    """The host's book model: ALIGNMENT_BOOK_MODEL, else by device (cuda: Base, anything else: SEW-D tiny).
    An unknown value is refused, so a typo stops the worker at start instead of picking a model silently."""
    env = os.environ if env is None else env
    value = str(env.get("ALIGNMENT_BOOK_MODEL", "")).strip().lower()
    if value:
        if value not in BOOK_ENGINES:
            raise ValueError(f"ALIGNMENT_BOOK_MODEL must be one of {', '.join(BOOK_ENGINES)} (got {value!r}).")
        return value
    device = str(env.get("ALIGNMENT_CTC_DEVICE", "cpu")).strip().lower()
    return WAV2VEC2_BASE if device.startswith("cuda") else SEW_D_TINY


def book_engine(model):
    return BOOK_ENGINES[model]
