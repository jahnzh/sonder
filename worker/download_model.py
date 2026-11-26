"""Explicit one-time download of model weights; no user media is uploaded.

Wav2Vec2 Base (window requests, and whole-book jobs on GPU hosts) and SEW-D tiny (whole-book jobs on CPU hosts,
#921), each pinned by SHA-256, into MEDIA_ROOT/alignment/models. A file already there is checked, not fetched.
"""
import os
import shutil
import urllib.request
from pathlib import Path
from ctc_acoustic import CHECKPOINT, checkpoint_path, verify_checkpoint
import ctc_sewd
root = Path(os.environ.get("MEDIA_ROOT", "/mnt/usb_4t_1/sonder")).resolve()
marker = root / ".media-volume"
expected = os.environ.get("MEDIA_VOLUME_ID")
if expected and (not marker.is_file() or marker.read_text().strip() != expected):
    raise RuntimeError("The mounted media volume is unavailable.")


def fetch(url, path, verify):
    """Download `url` to `path` through a temporary file that replaces it only once `verify` accepts it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.is_file():
        temporary = path.with_suffix(path.suffix + ".part")
        try:
            with urllib.request.urlopen(url) as source, temporary.open("wb") as target:
                shutil.copyfileobj(source, target)
            verify(temporary)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    verify(path)


fetch(f"https://download.pytorch.org/torchaudio/models/{CHECKPOINT}", checkpoint_path(root / "alignment"),
      verify_checkpoint)
print("Pinned Wav2Vec2 Base CTC weights are ready on the media drive (about 360 MB).")
sewd = ctc_sewd.model_folder(root / "alignment")
for name in ctc_sewd.FILES:
    fetch(ctc_sewd.file_url(name), sewd / name, lambda path, name=name: ctc_sewd.verify_file(path, name))
print("Pinned SEW-D tiny CTC weights are ready on the media drive (about 97 MB).")
