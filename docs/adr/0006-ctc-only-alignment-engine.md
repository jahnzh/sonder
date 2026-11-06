# One CTC acoustic model for all alignment work

Sonder generates every alignment map, and scores ebook candidates against the audio, with a single resident Wav2Vec2 Base CTC model (`WAV2VEC2_ASR_BASE_960H`), replacing both Whisper and aeneas. One acoustic pass per recording is cached and reused for locating passages, timing sentences and checking candidates; there is no hidden Whisper fallback. On the labelled sample Base met the 250 ms sentence and transition thresholds, and a chapter took 6.93 s on the WSL GPU against 38.43 s for the full current job. Keeping Whisper only for passage discovery kept almost all of that cost (39.40 s).

## Consequences

- **English only.** Base is trained on English LibriSpeech. A book in another language gets an explicit "language not supported" outcome and stays unsynced; there is no fallback engine.
- **Maps are disposable and always estimated.** Nobody reviews or corrects a map, so there is nothing to preserve or merge. A map made by an older engine generation is rebuilt automatically, and the new map replaces the old one when it finishes, even where it covers less.
- **Hosts.** The model runs on the WSL GPU. When WSL is unreachable, lisa runs the same engine on CPU; production's N150 worker does not run CTC. A map made on CPU and one made on GPU count as the same engine generation.
- **Retiring Whisper from probing** waits until CTC probing picks the same or a better edition than Whisper on the Dungeon Crawler Carl series.
- **TorchAudio is pinned to 2.8**, because `forced_align` is removed in 2.9. The path code sits behind one adapter, and replacing the kernel is a follow-up before any upgrade.
