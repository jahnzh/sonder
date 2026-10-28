# Host cleanup note

Everything for a run lives under `~/sonder-replication/<run-id>/` on the WSL host
(`192.168.1.119`) and nothing else on the host is touched. Nothing here is deleted
automatically; the corpus and venv are kept for reuse until someone decides otherwise.

| Path under `<run-id>/` | What | Size (issue6-1793194927) |
|---|---|---|
| `corpus/` | Parallel Audiobook Corpus zips (MD5-verified), `.verified` markers, extracted chapter | about 45 GB |
| `conda/`, `conda-pkgs/` | Python 3.10 and ffmpeg from conda-forge | about 0.8 GB + cache |
| `apt-root/`, `apt-debs/` | Ubuntu `espeak`, `libespeak-dev` etc. unpacked with `dpkg -x` (no root) | about 5 MB |
| `venv/`, `pip-cache/` | worker requirements (aeneas 1.7.3, faster-whisper 1.2.1, ...) | about 0.5 GB |
| `alignment/` | Whisper tiny model (about 75 MB) and worker scratch files | about 75 MB |
| `repo/` | clone of the branch, from the bundles `sonder*.bundle` | small |
| `results/`, `logs/` | run output (also copied to `artifacts/6/remote/` locally) | small |

To remove a finished run, after confirming the results were copied back:

```bash
ssh 192.168.1.119 'rm -rf ~/sonder-replication/<run-id>'
```

That is the only command needed: the conda prefix, the pip and conda caches
(`CONDA_PKGS_DIRS` and `PIP_CACHE_DIR` point inside the run directory) and the
unpacked apt files are all inside it. `~/miniconda` was used only as the `conda`
binary and is not modified. To free just the corpus, delete `corpus/` and keep the
environment. Check that no run process is alive first (`pgrep -u $USER -f
sonder-replication/<run-id>` is acceptable here because it is run alone, not inside
a waiter's own command line).
