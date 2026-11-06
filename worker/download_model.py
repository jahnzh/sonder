"""Explicit one-time download of model weights; no user media is uploaded."""
import os
import shutil
import urllib.request
from pathlib import Path
from faster_whisper.utils import download_model
from anchors import MODEL_REVISION
from ctc_acoustic import CHECKPOINT, checkpoint_path, verify_checkpoint
root = Path(os.environ.get("MEDIA_ROOT", "/mnt/usb_4t_1/sonder")).resolve()
marker = root / ".media-volume"
expected = os.environ.get("MEDIA_VOLUME_ID")
if expected and (not marker.is_file() or marker.read_text().strip() != expected):
    raise RuntimeError("The mounted media volume is unavailable.")
folder = root / "alignment" / "models" / "whisper"
folder.mkdir(parents=True, exist_ok=True)
download_model("tiny", cache_dir=str(folder), revision=MODEL_REVISION)
print("Local Whisper tiny weights are ready on the media drive (about 75 MB).")
ctc_path = checkpoint_path(root / "alignment")
ctc_path.parent.mkdir(parents=True, exist_ok=True)
if not ctc_path.is_file():
    temporary = ctc_path.with_suffix(".part")
    try:
        with urllib.request.urlopen(f"https://download.pytorch.org/torchaudio/models/{CHECKPOINT}") as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target)
        verify_checkpoint(temporary)
        temporary.replace(ctc_path)
    finally:
        temporary.unlink(missing_ok=True)
verify_checkpoint(ctc_path)
print("Pinned Wav2Vec2 Base CTC weights are ready on the media drive (about 360 MB).")
