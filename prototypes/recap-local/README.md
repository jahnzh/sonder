# Local "Story so far" recap: prototype

A throwaway prototype that answers one question: can the **Story so far** recap of the Resume recap design run on a local model on the WSL host's RTX 3070 Ti, instead of a hosted API? It also runs the same test on two hosted Claude models, to have something to compare with. The findings, the numbers and the recommendation are in [RESULTS.md](RESULTS.md).

Nothing in `server/` or `src/` is changed and nothing here is reached by the app. The prototype imports two existing helpers: `cutEpub` (`server/reader.ts`) for the sentence ids, and `normalizeReaderText` (`src/reading-types.ts`) for comparing quotes.

## What it does

The design under test is the one the panel recommended: stored chapter summaries that each saw only the text up to the end of their chapter (ADR 0008), plus the raw text of the current chapter up to the cutoff, with every claim citing a sentence at or before the cutoff.

| Step | File | What it does |
| --- | --- | --- |
| (a) | `extract.ts` | An EPUB as ordered chapters of sentences, with the reader's own sentence ids (`<spine index>:<count in the chapter>`). |
| (b) | `summarise.ts` | Walks the book forward. After each **unit** it stores the rolling story so far: notes of four kinds (who, goal, event, open question), each citing one sentence of its unit with a verbatim quote. |
| (c) | `recap.ts` | `--cutoff <sentence id> --gap <days>`: a recap from the stored notes that end before the reader's chapter and that chapter's raw text up to the cutoff, whose length follows the gap. Two modes: the model writes all of it, or (`--assemble`) code takes the earlier story from the stored notes word for word and the model writes only the current chapter's part. |
| (d) | `lib.ts` (`checkClaim`) | Drops every claim whose sentence lies after the cutoff or does not contain its quote. The recap is what is left. |
| | `matrix.ts` | Recaps at several positions and gaps, with the code checks of each. |
| | `names.ts` | The name check on stored outputs: claims with a capitalised word that is nowhere in the text read up to their cutoff. |
| | `llm.ts` | One request to a model, answered as JSON of a schema. Two providers: a local llama.cpp server (the schema becomes a grammar; an address that is not loopback or a private network is refused), and a hosted Claude model through the Claude Code CLI, for comparison (see "A hosted model next to the local ones"). |

Rules worth knowing:

- **Units.** A unit is a chapter. A chapter under 120 words (a title page) joins the next one. A chapter too long for the context is cut into near-equal parts at paragraph ends, and the notes are stored after each part.
- **The model adds, code keeps.** A summarising step returns new notes and the handles of earlier goals and questions that its text settles. A note is stored once and carried word for word, so a citation cannot drift from step to step. The story so far after a unit is chosen by code (`storyOf`) from all notes up to it: the most mentioned names with the note that introduced each and the latest note about it (14 notes), the goals and questions not yet settled (5 each), and 20 events, of which ten are the latest and ten an arc of the book before them, the weightiest event of each tenth of the text.
- **What a recap sees.** The notes stored at the end of the last unit before the reader's chapter, and the chapter's text from its first sentence to the cutoff. When that text does not fit, it starts at the latest part of the chapter that does, with the notes stored before that part. Those notes also end before the cutoff.
- **Length.** Under 3 days 60–100 words, 3–14 days 150–250, 2–8 weeks 300–400, longer about 500. A recap is at most a fifth of the words read so far, so a band steps down early in a book. A model cannot count words, so the schema fixes the number of claims per group instead, from the model's own words per claim as measured on its stored notes. The order is who and where, goals, events, last scene, open question.
- **Names.** A "who" note has its name in a field of its own, and some models then leave the name out of the sentence. Wherever a note is shown, the name is put back (`named` in `lib.ts`).
- **The checker.** A quote is compared after `normalizeReaderText`, with typographic quotes, dashes and letter case folded (reported separately as "not exact"). It must be at least 12 characters. A quote that is in a neighbouring sentence the model was shown, and nowhere else, moves the citation there ("repaired"). An id after the cutoff is never repaired. A claim that repeats an earlier claim of the same recap is left out and counted apart from citation drops.
- **The schema check.** Every reply is held against its JSON schema by code (`conform` in `lib.ts`). For llama.cpp that never finds anything, because the grammar already forces the schema. For a hosted model nothing forces it: a list item that breaks its schema is left out, a list that is too long is cut, and each such place is counted as a schema violation.
- **The name check.** A capitalised word in a kept claim that occurs nowhere in the text read so far is reported (`namesNotIn`): a name from outside the book, or a made-up one. It reports and does not drop yet; RESULTS.md says why it should.
- **Not checked by code:** whether the quoted sentence supports the claim. See RESULTS.md.

## The fixture

`fixture/story.ts` is an invented story of eight short chapters, *The Salt Ledger*, written for this prototype. `fixture/build.ts` writes it as an EPUB so that it goes through the same extractor as a real book. It holds:

- a character who leaves in chapter 1 and returns at the end (Tobiah Wren);
- two characters with the same given name (Mara Venn, Mara Lisle);
- an identity revealed in chapter 7 (who "the Cormorant" is);
- an object planted in chapter 1 that pays off in chapter 7 (the brass key);
- a scene left unresolved on purpose at the end of chapter 5, explained in chapter 8;
- a clue that invites a guess the text has not confirmed (tar and juniper);
- a short flashback;
- a line of prompt injection in the book's own text (the handbill in chapter 4).

`fixture/traps.ts` has three cutoffs and, for each, patterns for the facts that come after it. A pattern that matches a recap is a candidate leak. Some are certain (a name that has not appeared yet); the others need a person to read the line.

## Running it

The model server runs on the WSL host (`jahn@192.168.1.119`), bound to loopback, and the scripts run there too. Everything lives under `~/recap-proto`, apart from the alignment worker, which is never touched: `wsl/serve.sh` refuses to start while that worker reports work, and `wsl/measure.sh` logs every second in which it did.

Install (no sudo; about 15 GB):

```sh
mkdir -p ~/recap-proto/{llama/b12589,models,logs,work/books,work/runs}
cd ~/recap-proto/llama
B=b12589; base=https://github.com/ggml-org/llama.cpp/releases/download/$B
curl -LO $base/llama-$B-bin-ubuntu-cuda-13.5-x64.tar.gz && tar -xzf llama-$B-bin-ubuntu-cuda-13.5-x64.tar.gz -C $B
curl -LO $base/cudart-llama-$B-bin-ubuntu-cuda-13.5-x64.tar.gz && tar -xzf cudart-llama-$B-bin-ubuntu-cuda-13.5-x64.tar.gz -C $B
cd ~/recap-proto/models
curl -LO https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf
curl -LO https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q6_K.gguf
curl -LO https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf
```

Copy this checkout to `~/recap-proto/work/sonder`, run `npm ci` in it, and copy `prototypes/recap-local/wsl/` to `~/recap-proto/wsl/`. Then:

```sh
cd ~/recap-proto/work/sonder
npx tsx prototypes/recap-local/fixture/build.ts ../books/fixture.epub
npx tsx prototypes/recap-local/extract.ts ../books/fixture.epub ../books/fixture.json --title "The Salt Ledger"
npx tsx prototypes/recap-local/extract.ts ../books/dcc1.epub ../books/dcc1.json --title "Dungeon Crawler Carl"

# One configuration end to end: server up, notes for each book, recaps at 3 positions x 2 gaps, GPU memory log, server down.
~/recap-proto/wsl/measure.sh gemma4-e4b-qat-q4 gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf 16384

# Or by hand, with a server from wsl/serve.sh running:
npx tsx prototypes/recap-local/summarise.ts --book ../books/fixture.json --out ../runs/fixture.states.json --label try
npx tsx prototypes/recap-local/recap.ts --book ../books/fixture.json --states ../runs/fixture.states.json --cutoff 6:15 --gap 30

~/recap-proto/wsl/assemble-run.sh gemma4-e4b-qat-q4 gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf 16384   # the same recaps in assembled mode
~/recap-proto/wsl/show.py ~/recap-proto/work/runs/gemma4-e4b-qat-q4 fixture --notes   # read a run (--assembled for that mode)
~/recap-proto/wsl/audit.py ~/recap-proto/work/runs/gemma4-e4b-qat-q4 dcc1 ~/recap-proto/work/books --n 30   # claims next to their cited text, to judge by reading
~/recap-proto/wsl/report.py ~/recap-proto/work/runs gemma4-e4b-qat-q4 --json numbers.json                   # the tables of RESULTS.md
~/recap-proto/wsl/probe.sh Qwen3.5-4B-Q6_K.gguf 32768                                # memory and speed of one setting
~/recap-proto/wsl/stop.sh                                                            # stop the server, show the GPU memory
```

`wsl/serve.sh` starts `llama-server` with all layers on the GPU, flash attention, an 8-bit KV cache and reasoning off (`--reasoning off --reasoning-budget 0`: Gemma 4 kept reasoning with the first flag alone and spent its reply on it). `RECAP_NGL` and `RECAP_KV` change the layers on the GPU and the KV cache type. `RECAP_ONLY_RECAPS=1 measure.sh …` makes the recaps again from stored notes.

`llm.ts` asks again, with another seed, when a reply is not JSON or the server fails a request (llama.cpp's grammar sampler did that now and then); a unit that fails three times adds no notes and is marked in the stored state.

Checks of the prototype itself:

```sh
npx tsc --noEmit -p prototypes/recap-local
npx tsx --test prototypes/recap-local/lib.test.ts
```

## A hosted model next to the local ones

`hosted.sh` runs the same books, cutoffs, gaps and both recap modes on a hosted Claude model, through the Claude Code CLI that is signed in on the machine (`claude -p --model … --output-format json`), so on the owner's subscription and without an API key:

```sh
prototypes/recap-local/hosted.sh claude-haiku-5-5 claude-haiku-5-5 <books folder> <runs folder>
prototypes/recap-local/hosted.sh claude-sonnet-5-5 claude-sonnet-5-5 <books folder> <runs folder>
```

- **Same pipeline.** `RECAP_PROVIDER=claude-cli` and `RECAP_MODEL` switch `llm.ts` to the CLI; the prompts, schemas, cutoff rules and checks are the ones the local models get. Node 24 runs the scripts as they are, so no dependencies are needed on the machine that has the CLI.
- **Only the prompt.** The CLI runs in an empty temp folder with `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, `--no-session-persistence`, the request's own text as `--system-prompt`, and an environment without the variables of the session that started it. It still adds about 650 tokens of its own to each prompt.
- **No grammar.** The schema is written into the prompt, and the reply is held against it by the schema check.
- **Thinking stays on.** The CLI cannot turn it off; `--effort low` (`RECAP_EFFORT`) keeps it short. Thinking tokens are counted as output and reported apart.
- **One request at a time, never asked again.** A reply that is not JSON of the schema's shape fails its unit or recap. A usage or rate limit stops the run (exit 3); running the script again with the same label goes on from the books and recaps that are there.
- **Cost.** A subscription call costs nothing extra, so `llm.ts` works out what each call would cost on the API from the token counts the CLI reports, with every prompt token at the input price (no prompt caching). A production server would call the API with a key; times measured through the CLI include its start-up, about half a second.
- **The real book's text goes to Anthropic** in these runs. The owner approved that for this test.

## Token estimate

Units are sized without the model's tokenizer, at 3.4 characters per token plus 7 per sentence id. A prompt estimated at 6,000 tokens was 6,673 tokens for Qwen3.5 and 6,631 for Gemma 4, so the estimate runs about 11% low; the unit budget leaves 18% for it. At a 16,384-token context a unit holds up to about 10,100 real tokens of text.

## Privacy

With a local model the book's text goes to `127.0.0.1` on the WSL host and nowhere else. With the hosted comparison it goes to Anthropic through the CLI. This repository is public: the outputs for a real book hold its text and are not committed. `results/` holds the fixture's outputs for each measured model (its stored notes, its recaps in both modes and its GPU memory), which are invented text, and `results/numbers.json` and `results/probes.jsonl`, which are numbers only.
