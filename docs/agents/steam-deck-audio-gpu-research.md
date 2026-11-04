# Steam Deck audio GPU pilot: background and method

Research for the requested pilot, 2026-10-30. This note records background, method and the completed pilot results below.

## Fit for Sonder

`worker/anchors.py` loads the multilingual Whisper `tiny` model through faster-whisper on CPU with `int8` and two CPU threads. It extracts a 16 kHz mono excerpt, transcribes with beam size 1, no previous-text conditioning and word timestamps, then matches the recognized words to supplied ebook fragments. `worker/align_task.py` separately runs aeneas over the chosen text/audio section; speech recognition also checks a short excerpt for mismatches. Accelerating Whisper would affect the anchoring/check portion, not automatically accelerate aeneas or give an end-to-end alignment speedup. See [`worker/anchors.py`](../../worker/anchors.py) and [`worker/align_task.py`](../../worker/align_task.py).

[whisper.cpp documents a Vulkan GPU backend](https://github.com/ggml-org/whisper.cpp#vulkan-gpu-support), a [Vulkan image and GPU device passthrough example](https://github.com/ggml-org/whisper.cpp#docker), and a [16-bit mono 16 kHz WAV input conversion](https://github.com/ggml-org/whisper.cpp#quick-start). [faster-whisper's own GPU setup](https://github.com/SYSTRAN/faster-whisper#requirements) documents NVIDIA CUDA dependencies; this does not establish that the installed worker can use the Deck's AMD GPU. A switch to whisper.cpp is a new transcription backend with potentially different model representation, decoding behavior and timestamps, not simply a setting change.

## Candidate experiment

1. Run only when Deck CI, emulator and other expensive jobs are not active. Use a unique, bounded scratch directory and container; preserve unrelated workloads and clean up only pilot-owned resources. Capture host OS, GPU/driver, available RAM, power/thermal context, image digest, model name/hash, thread count and exact commands.
2. Use the same pinned Vulkan-capable whisper.cpp image, model, 16 kHz mono WAV, language, thread count and decoder settings for both cases. Run GPU once with the render device passed through, and CPU with `--no-gpu`. The [CLI implementation](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp) exposes `--no-gpu`, `--beam-size`, `--best-of`, `--no-fallback`, `--threads`, language and timing/output options; confirm them against the actual image's `--help`. Use multilingual tiny first and beam size 1 to resemble Sonder, but do not assume decoding and word-timestamp semantics match faster-whisper. Confirm the log identifies the real AMD Vulkan device rather than CPU fallback or software Vulkan.
3. Use disposable public-domain/consented audio with a transcript, or synthetic speech with known text, not production media. Upstream supplies [a JFK sample](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav); one short synthetic sample tests plumbing but cannot stand in for varied natural audiobook narration. Record exact input duration. Include approximately 30-second excerpts to resemble the worker. Try at least one natural-spoken clip where feasible, and keep samples unchanged between runs.
4. Record cold-start wall time (including model loading), processing time if the program reports it, real-time factor (wall seconds / audio seconds), exit status, peak process memory and logs identifying the selected backend. Run repeated trials and vary execution order; distinguish warm disk/file caches from a persistently loaded model. Compare normalized transcript against known text and calculate word error rate when a trustworthy reference exists. Keep audio generation/download and conversions outside the timing window. Single measurements are exploratory, not estimates of sustained production throughput.
5. If practical, make a separate comparison with the existing faster-whisper CPU implementation using the exact input and as closely matched model/settings as available, reporting model version and all remaining differences. Verify word timestamp alignment and `match_excerpt` outcomes for representative passages, skipped text and edition mismatches. Model quantization, different inference engines and decoder defaults can alter both performance and transcript quality.

No existing production worker is changed by this experiment. A real adoption decision needs representative audiobook excerpts, audio/network transfer and worker startup costs, workload scheduling, and comparison of recognition quality and downstream anchor success. GPU and CPU share the Deck's memory and power budget, and container device permissions, Vulkan libraries and actual sustained stability must be verified on this host.

## Pilot results — 2026-10-30

The Deck's active CI completed before this pilot ran. Twelve whisper.cpp trials and six faster-whisper trials completed successfully, with no other Sonder CI/emulator container observed at the beginning of each trial. The Deck was on AC power. SteamOS 3.9.5, kernel `7.2.7-valve2-2-neptune-72-g31504582a073`; Vulkan reports `AMD Custom GPU 0932 (RADV VANGOGH)`. The GPU logs say `whisper_backend_init_gpu: using Vulkan0 backend`; the whisper.cpp CPU logs say no GPU was selected. No GPU load, power, thermal, or peak-memory measurement was captured.

We used public [whisper.cpp JFK audio](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav) (11.0 s, SHA-256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`) and an original 31.229 s passage generated with `espeak-ng -v en-us -s 155`, then converted to 16 kHz mono PCM. The synthetic WAV SHA-256 was `ed1a3dcf7cc9f90bd9081bd89551a00ed073a1c9c72ffbc97c912f071c24a6ad`.

Each whisper.cpp run used the official `main-vulkan` image, digest `sha256:1090badf58652c073ca8963b7718dbc3a8dd1dddfb0965d5c5efd2b0c0b83ea4`, and multilingual `ggml-tiny.bin`, SHA-256 `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21`. All runs used 2 CPU cores, 2 GiB cgroup limit and `-t 2 -bs 1 -bo 1 -nf -l en`; CPU runs added `--no-gpu`. Each backend ran three times per clip, with CPU and GPU order alternated. Every trial started a new container and process; wall time includes launch, model load and inference but excludes audio preparation and model download. The OS and shader caches were not cold.

| Clip | Engine | Trial wall times (s) | Median (s) | Median wall time / clip duration |
| --- | --- | --- | ---: | ---: |
| JFK, 11 s | whisper.cpp Vulkan | 1.361, 1.333, 1.357 | 1.357 | 0.123 |
| JFK, 11 s | whisper.cpp CPU | 1.751, 1.737, 1.655 | 1.737 | 0.158 |
| JFK, 11 s | faster-whisper CPU | 2.239, 2.218, 2.296 | 2.239 | 0.204 |
| Synthetic, 31.229 s | whisper.cpp Vulkan | 2.003, 1.734, 2.011 | 2.003 | 0.064 |
| Synthetic, 31.229 s | whisper.cpp CPU | 3.439, 2.978, 3.469 | 3.439 | 0.110 |
| Synthetic, 31.229 s | faster-whisper CPU | 3.291, 3.020, 3.028 | 3.028 | 0.097 |

For the closest controlled comparison, Vulkan was about 1.28× and 1.72× as fast as whisper.cpp CPU on the two clips respectively. The faster-whisper comparison is indicative only: its separate Python image (digest `sha256:6d10e720318bd84cc3d88af92bb5a47189222e17620a2fd214da6445e4afb679`) and imports affect startup, it uses int8 instead of the ggml model representation, and it computes word timestamps, while the whisper.cpp command used segment output. It used `faster-whisper==1.2.1`, CTranslate2 4.8.4, the worker's pinned `Systran/faster-whisper-tiny` revision `d90ca5fe260221311c53c58e660288d3deb8d356`, `device=cpu`, `compute_type=int8`, `cpu_threads=2`, `beam_size=1`, `condition_on_previous_text=False`, `word_timestamps=True` and `language=en`. Each run loaded the model anew, as the worker child does. The test used already-decoded WAV; it did not include the worker's FFmpeg extraction, network transfer, queueing or aeneas.

For a small quality check, lowercased word-token edit distance against the known texts gave 0/22 errors for all JFK trials. For synthetic speech it was 27/95 (28.4%) on whisper.cpp GPU, 29/95 (30.5%) on whisper.cpp CPU and 39/95 (41.1%) on faster-whisper CPU. This is a tiny, artificial sample, not an estimate of real audiobook accuracy; tokenization treats punctuation as separators. Feeding each recognized transcript to Sonder's existing `match_excerpt` with its own reference as the only candidate yielded scores 1.0 for JFK and 0.760, 0.736 and 0.660 respectively for the synthetic passage. This checks basic matching only; it does not test competing passages, edition mismatches, word timing or real anchor placement.

**Assessment:** GPU offload is technically viable on this Deck and accelerated this small controlled Whisper workload. It does not establish an end-to-end Sonder speedup or justify switching backends yet. The next useful experiment is representative public or user-authorized audiobook excerpts with real reference text, competing passages and timestamp/anchor checks, plus a fair comparison of complete worker requests and transfer overhead. Avoid running the pilot alongside CI or the emulator; the current CI runner has no lock coordinated with this scratch pilot.

The exact synthetic reference was:

> The train arrived just after sunrise, when the station was still quiet and the lamps along the platform were beginning to fade. Mara carried a small leather case and a letter she had not yet opened. Across the river, the old clock tower struck seven, and a flock of birds rose above the roofs. She had come to find her brother, but the address in her pocket led to a house that no longer appeared on any map. At the end of the street, a baker unlocked his shop and asked whether she needed directions.

The core whisper.cpp invocation, with `<scratch>` containing the model and WAV and `<clip>` set to `jfk` or `narration`, was:

```sh
podman run --rm --network none --cpus 2 --memory 2g \
  --device /dev/dri/renderD128 -v '<scratch>:/data:ro' \
  ghcr.io/ggml-org/whisper.cpp@sha256:1090badf58652c073ca8963b7718dbc3a8dd1dddfb0965d5c5efd2b0c0b83ea4 \
  whisper-cli -m /data/ggml-tiny.bin -f /data/<clip>.wav \
  -t 2 -bs 1 -bo 1 -nf -l en
```

Add `--no-gpu` for the CPU comparison. The real pilot used the resolved local image ID and `nice -n 10`, guarded each run against active Sonder CI/emulator containers, and timed the complete `podman run` with a 120-second timeout. Confirm the host GPU and container permissions before repeating.
