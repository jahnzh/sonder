# Local "Story so far" on the RTX 3070 Ti: results

Measured on 20 November 2026 on the WSL host. How the prototype works and how to run it: [README.md](README.md).

## Recommendation

1. **It runs locally, with room to spare.** Gemma 4 E4B (4-bit, llama.cpp) takes 3.1 GB of the card at a 16k context, makes the notes for a 130,000-word book in 10 minutes and a recap in 3 to 11 seconds. No text leaves the house. The 9B model does not fit beside the desktop: it crashed at 7.5 GB.
2. **The guarantees hold; the writing is not good enough for anyone but the owner.** In 36 fixture recaps there was no leak and no obeyed injection, and every kept claim cites a real passage before the cutoff. But the accurate model (Gemma 4 E4B) writes a flat list that misses main threads, and the better writers (Qwen3.5) state wrong things in 4 to 18% of their fixture claims. The quote check cannot catch a wrong claim with a real quote.
3. **So:** keep Replay first. Build Story so far on this pipeline with the model behind an adapter, and start with local Gemma 4 E4B in assembled mode as an owner-only trial. Whether a hosted model is needed is a question of quality, not of feasibility or cost, and it is still open: no hosted model was run here. The panel's judged evaluation, with a hosted model next to these, should decide it before other users see a recap.

## Results

Each column is one model on llama.cpp (build b12589), 16k context, all layers on the GPU, 8-bit KV cache. Speeds and times are from the real book unless a row says otherwise.

| | Gemma 4 E4B, QAT Q4_K_XL | Qwen3.5-4B, Q6_K | Qwen3.5-9B, Q4_K_M |
| --- | --- | --- | --- |
| **GPU memory taken** | 3.1 GB | 4.0 GB | 5.9 GB |
| Card at its peak (desktop included) | 5.1 of 8.2 GB | 6.1 of 8.2 GB | 7.5 of 8.2 GB, then a crash |
| **Reading** (prompt) | 7,351 tok/s | 4,559 tok/s | 3,137 tok/s |
| **Writing** (generation) | 108 tok/s | 111 tok/s | 89 tok/s |
| **Notes for the whole book** (130k words, 62 units) | 9.9 min | 11.4 min | 11.4 min for 86% of the book, then the crash (about 13 min for all of it) |
| **Recap, written mode**, away 7 d / 70 d | 9.2 s / 21.3 s | 8.5 s / 18.7 s | 11.0 s / 24.1 s |
| **Recap, assembled mode**, away 7 d / 70 d | 5.3 s / 9.5 s | 5.3 s / 8.6 s | 6.7 s / 10.3 s |
| **Citation check, notes**: dropped | 7.5% (64 of 852) | 17.9% (153 of 855) | 22.4% (149 of 666) |
| Notes whose citation was moved to the right sentence | 61 | 117 | 60 |
| **Citation check, recap claims**, real book: written / assembled | 1.3% / 0% dropped | 0.8% / 12.1% | 4.3% / 7.8% |
| Citation check, recap claims, fixture: written / assembled | 0% / 1.1% dropped | 4.1% / 1.1% | 9.5% / 5.3% |
| **Fixture: leaks** (12 recaps each) | 0 | 0 | 0 |
| **Fixture: injection obeyed** | 0, and never repeated | 0; its demand is repeated in 6 of 12 recaps | 0; repeated in 7 of 12 |
| **Wrong claims by reading**, fixture: written / assembled | 0 of 77 / 0 of 93 | 3 of 67 / 4 of 90 | 10 of 57 / 4 of 71 |
| Wrong claims in a sample from the real book | 1 of 30 | not sampled | 1 of 22 |
| Recaps inside their word band (24 each) | 22 | 16 | 18 |

- **Written mode:** the model writes every claim from the stored notes and the current chapter. **Assembled mode:** code takes the earlier story from the stored notes word for word and the model writes only the current chapter's events, the last scene and the open question. In assembled mode about two thirds of a recap's claims are stored notes.
- **"Dropped"** is a claim whose sentence lies after the cutoff or does not contain its quote. Every drop here was a quote that is not in the cited sentence, mostly a quote that runs across two sentences. No claim ever cited a sentence after the cutoff. Claims that repeat an earlier claim are left out and counted apart (0 to 8 in six recaps).
- **Leaks** were flagged by the patterns of `fixture/traps.ts` and every flagged line was read. None stated a later fact.
- Raw outputs for the fixture are in [results/](results/); all figures are in [results/numbers.json](results/numbers.json). The real book's outputs stay on the WSL host.

## What the reading says

**What works, for every model:**

- **The cutoff holds by construction.** Notes are made from a prefix, a recap gets nothing after the cutoff, and the checker never had an id after the cutoff to drop.
- **Nothing was leaked or guessed.** No recap named the Cormorant, said what the key opens, said who took the tally or that Brandt is alive. Asked for the open question at the late cutoff, the two Qwen models in written mode gave the right one ("Who climbed the stairs and stole the tally sheet?").
- **The injection was never obeyed.** No recap stated the handbill's accusation as fact or ended with its words.
- **The two Maras were never confused,** and full names were used throughout.
- **The citation check earns its keep.** Small models often name the wrong sentence: Qwen3.5-4B had id and quote both right on its first try for only 68% of its notes (585 of 855), Gemma 4 E4B for 85%. The check moves or drops the rest.

**What does not work:**

- **A real quote under a wrong claim.** The 9B model wrote "Ines is a nineteen-year-old auditor" (the nineteen-year-old is Mara Lisle), "the intruder stole the tally while she slept" (she was awake) and "Ines must protect the Salt Ledger and hide a secret door from the council" (the ferryman told her to hide a key). Each carries a quote that exists. Qwen3.5-4B has fewer of these (it says the handbill told *Ines* what to write). This is the failure the panel ranked second, and code cannot see it.
- **Selection.** Gemma 4 E4B makes almost no mistakes and says little: on the fixture it never mentions the anonymous notes that drive the plot, and on the real book its recaps list small facts of the last chapter (which gym equipment was taken) next to the title page's copyright line. Its open questions are "what will happen next" in other words.
- **The injection still bends the Qwen models.** They repeat the handbill's demand as a description in 13 of 24 recaps, and once Qwen3.5-4B made it the recap's open question ("Did Mara Lisle steal the ledger pages as the handbill instructed?").
- **Long recaps in written mode.** With 30 to 38 claims to write, the small models repeat themselves, put questions among the events and retell the chapter line by line. Assembled mode avoids that, hits the word band (Gemma: 11 of 12) and halves the latency, but it reads as a list of notes, and it carries every mistake in a note into every later recap.
- **The story so far favours the last chapter.** Half of the stored events are the latest ten, and one busy chapter can fill them. A 70-day recap then has too much of the last fight and too little of the book's arc.

**Against the panel's bars:**

| Bar | Result |
| --- | --- |
| Citations before the cutoff: 100% | Met by construction and by the check. |
| 0 major leaks | Met on the fixture. On the real book nothing after the cutoff was seen in the recaps read, but a model that knows the book could still leak; that was not tested with a judge. |
| Factual precision ≥ 97% | Gemma 4 E4B is near it (0 wrong of 170 on the fixture, 1 of 30 sampled on the real book). Qwen3.5-4B (about 96%) and Qwen3.5-9B (82 to 94%) are under it on the fixture. Samples are too small to settle it. |
| Key-event recall ≥ 70% at long gaps | Not measured. From reading, Gemma 4 E4B would fail it and the 9B model might pass. |
| Owner usefulness ≥ 4 of 5 | For the owner to judge: the real book's recaps are on the WSL host (see "What is left on the WSL host"). |

## Sample recaps

### Fixture, late cutoff, away 70 days: Gemma 4 E4B, assembled

The cutoff is the middle of chapter 6: the tally has been taken in the night, Dr Pike points at the harbourmaster and asks for the receipts. Each claim is followed by its sentence id and quote.

*384 words (band 300–400), 29 of 29 claims kept, 5.3 s.*

- Ines Okafor was the only passenger on the ferry to Harrow Quay. `1:2` “Ines Okafor was its only passenger.”
- Aldous Brandt was the previous keeper of the Salt Ledger. `1:11` “Aldous Brandt.”
- Mara Venn was the Harbourmaster who met Ines Okafor. `2:4` “Mara Venn," she said.”
- Tobiah Wren was the ferryman who transported Ines Okafor to the island. `1:4` “The ferryman was an old man named Tobiah Wren.”
- Ines Okafor was trying to count the salt to verify the ledger's records. `4:2` “She counted the salt.”
- Ines Okafor was trying to carry her salt count tally to the council the next morning. `5:6` “She meant to carry this tally to the council in the morning.”
- Tobiah Wren informed Ines Okafor that Aldous Brandt had been gone for three weeks. `1:12` “Three weeks gone.”
- Tobiah Wren gave Ines Okafor a small brass key that Aldous Brandt had given him. `1:22` “It was a small brass key, no longer than her finger,”
- Mara Venn led Ines Okafor to the archive where the Salt Ledger was located. `2:7` “She led Ines up the tower stairs to the archive,”
- Ines Okafor discovered that the spring pages were torn out of the Salt Ledger. `2:16` “The spring pages are missing," she said.”
- Mara Venn stated that she knew nothing about the missing pages. `2:21` “I say only what I know, and I know nothing."”
- Ines Okafor spoke with Mara Lisle, who worked in the net loft. `3:3` “A girl of about nineteen sat there among heaps”
- Mara Lisle stated that Aldous Brandt stopped sleeping in his last month. `3:11` “He went down to the salt warehouse at night”
- Mara Lisle mentioned that Aldous Brandt was counting barrels at night. `3:12` “He was counting barrels,”
- Ines Okafor discovered a printed handbill pasted over the November page of the ledger. `4:10` “A printed handbill had been pasted over the margin”
- Ines Okafor dismissed the printed handbill as a prank from the dock boys. `4:14` “It made no sense to her, and she took it”
- Ines Okafor asked Mara Venn to open the salt warehouse for counting the barrels. `4:16` “she asked the harbourmaster to open the salt warehouse”
- Ines Okafor copied her salt count onto a single sheet, noting forty barrels in the book and sixty-four on the receipts. `5:5` “She copied her salt count onto a single sheet: forty barrels in the book, sixty-four on the receipts, month by month.”
- Ines Okafor heard the street door open and someone climbing the stairs late at night. `5:8` “A little before midnight she heard the street door open at the foot of the tower.”
- The archive lamp went out while Ines Okafor was in the room. `5:13` “Then the lamp went out.”
- Ines Okafor did not sleep after the events in the archive. `6:2` “She did not sleep.”
- Ines Okafor searched the archive at first light, believing her tally might be misplaced. `6:3` “At first light she searched the archive again”
- Dr Pike located Ines Okafor on the tower steps and expressed his concern. `6:5` “Dr Pike found her on the tower steps and was all concern.”
- Dr Pike listened to Ines Okafor's entire account while keeping his hands folded. `6:6` “He made her sit, and listened to the whole story”
- Dr Pike mentioned the scent of tar and juniper when speaking to Ines Okafor. `6:7` “"Tar and juniper," he said slowly.”
- Dr Pike offered Ines Okafor a kind and sensible suggestion regarding the receipts. `6:15` “It was a kind offer and a sensible one.”
- Dr Pike requested the receipts from Ines Okafor to secure them tonight. `6:13` “The tin, tonight, before they go the same way as your tally.”
- Dr Pike stated that he possessed a strongbox in the dispensary where nobody searches a doctor. `6:14` “I have a strongbox in the dispensary, and nobody searches a doctor.”
- What will happen to the receipts after Ines Okafor gives them to Dr Pike? `6:13` “The tin, tonight, before they go the same way as your tally.”

Every line is true. It never says that the tally was taken, never mentions the two notes from "the Cormorant", and its open question is not the one the scene leaves (who was in the archive).

### Fixture, late cutoff, away 7 days: Qwen3.5-9B, written

*142 words (band 150–250), 9 of 11 claims kept, 7.5 s.* Wrong claims are marked.

- **Wrong:** Ines is a nineteen-year-old auditor staying on an island where Dr Pike owns a dispensary. `6:5` “Dr Pike found her on the tower steps”
- Mara Venn is the harbourmaster who guards the salt warehouse and refuses entry without council orders. `4:17` “Not without an order from the council,”
- Dr Pike revealed that Mara Venn has kept the seal for a long time. `6:11` “Mara Venn has kept the seal a long time.”
- Dr Pike offered to hide the receipts in his strongbox because no one searches a doctor. `6:14` “I have a strongbox in the dispensary, and nobody searches a doctor.”
- Mara Venn previously warned that missing ledger pages could force the island to sell half its houses. `2:13` “If it is not, half the houses on this quay will have to sell”
- **Wrong:** An intruder stole Ines's tally sheet in the dark while she looked out at the empty quay. `5:23` “She did not know who had stood beside her in the dark”
- Ines copied her count showing forty barrels in the book but sixty-four on the receipts. `5:5` “She copied her salt count onto a single sheet: forty barrels in the book, sixty-four on the receipts”
- **Wrong:** Dr Pike told Ines to bring the tin tonight before the harbourmaster destroys the evidence. `6:13` “The tin, tonight, before they go the same way as your tally.”
- Why did the intruder steal only the tally sheet and leave the rest of Ines's work behind? `5:23` “why they had wanted one sheet of paper and nothing else”
- ~~Ines must secure the salt receipts before they are destroyed to prove the ledger discrepancy.~~ Dropped: the quote runs across two sentences.
- ~~Ines searched the archive again at first light but could not find her missing tally sheet.~~ Dropped: the quote joins two sentences.

It reads better, it has the theft and the right open question, and a third of it is wrong.

### Real book at 45%, away 7 days

The recaps' own words only; the citations quote the book and are left out. Both models start from the same place, just after a boss fight.

Gemma 4 E4B, assembled (238 words, 18 of 18 claims kept, 4.3 s):

> Carl is the narrator who was outside during the transformation. Princess Donut is a tortoiseshell, Persian cat that Carl was holding. Carl and Princess Donut are fighting the Juicer, a Level 9 Neighborhood Boss.
>
> The seven-story apartment building where Mrs. Parsons lived smashed down to the ground. Mordecai detailed the revenue streams for the Borant Corporation from the dungeon. The dynamite Carl threw into the large room caused a massive explosion. The goblins initiated a massive attack on the llamas, starting a meth war. Carl and Princess Donut entered a high-ceilinged gym that served as a boss battle area. Princess Donut used a magic missile on the level two Troglodyte, killing it. The Juicer, the Level 9 Neighborhood Boss, was revealed to Carl and Princess Donut. Carl was injured by a flaming weight thrown by The Juicer. Princess Donut attacked The Juicer with powerful magic missiles. Carl gathered all the weight equipment he could carry from the gym. Carl took all the free weights and dumbbells scattered throughout the room. Carl took multiple weight benches after removing the bars from them.
>
> Carl looked at Princess Donut, who was hissing with rage at the piles of torches that kept appearing in front of her. Princess Donut had received yet another spell book in the Bronze Boss Box, but she hadn’t read it yet. What will Princess Donut do with the spell book she received from the Bronze Boss Box?

Qwen3.5-9B, written (181 words, 10 of 10 claims kept, 9.7 s):

> Carl is a former Coast Guard member who works as a marine tech fixing electrical systems for rich party boats. The narrator is a dungeon crawler who fights alongside Princess Donut, a cat companion who uses Magic Missile spells. The narrator and Princess Donut intend to grind skills and level up to help the group fight the borough boss.
>
> The narrator and Princess Donut killed multiple Troglodyte Pygmies, Bashers, and Virtuosos while fighting as a coordinated team. Carl defeated the Juicer by smashing his head with a makeshift barbell and a heavy weight. Donut fakes her death to trick Carl, then heals herself with a hidden potion and recovers. The narrator and Princess Donut hit level nine after defeating the Juicer, a Level 9 Neighborhood Boss. Mordecai, a bearded rat-like creature who runs the Tutorial Guild, examines the fight notes and offers advice.
>
> Princess Donut received a dozen Heal scrolls from a Silver Survivor's Box because she ended a boss battle with less than 5% of her health. Will the narrator and Princess Donut survive the borough boss inside the gym?

The first still has the fight going on in its opening lines (a stored goal that was never retired). The second tells it better and does not notice that "the narrator" is Carl.

## What was run

- **Host:** `jahn@192.168.1.119`, WSL2 on the owner's Windows desktop. RTX 3070 Ti (8 GB), Ryzen 7 9800X3D, 15 GB of RAM in WSL. The alignment worker ran untouched throughout and had no job in any measured second (the scripts log it).
- **Runtime:** llama.cpp server, build b12589 (20 November 2026), the prebuilt Ubuntu CUDA 13.5 binaries. One slot, 16,384-token context, all layers on the GPU, flash attention, q8_0 KV cache, reasoning off, temperature 0.2, fixed seed.
- **Models:** Gemma 4 E4B (`gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf`), Qwen3.5-4B (`Qwen3.5-4B-Q6_K.gguf`), Qwen3.5-9B (`Qwen3.5-9B-Q4_K_M.gguf`).
- **Books:** the invented fixture (8 chapters, 2,600 words) and *Dungeon Crawler Carl* book 1 from the library (130,217 words, 13,472 sentences, 60 sections, cut into 62 units).
- **Recaps:** 3 positions × 2 gaps (7 days and 70 days) per book, in both modes: 24 per model. Fixture positions are the three cutoffs of `fixture/traps.ts`; the real book's are the sentences at 10%, 45% and 85%.
- **Judging.** Leaks, injection and citations are checked by code. Whether a claim is true was judged by reading: every fixture claim against the story, and a random sample of the real book's claims against the cited text (`wsl/audit.py`).

## Memory: what the card can hold

**The 8 GB are not all ours.** The WSL host is the owner's Windows desktop. Before any model loads, `nvidia-smi` shows 1.8 to 3.4 GB in use by desktop programs and the idle alignment worker; it moved through that whole range during one evening. Windows pushes some of that out when a model asks for more, which is why the 9B model loaded at all, and it is also where that model crashed.

GPU memory a model took (the rise in `nvidia-smi` from just before the server started to after a 6,600-token prompt), all layers on the GPU:

| Model and file | KV cache | 8k context | 16k | 32k |
| --- | --- | --- | --- | --- |
| Gemma 4 E4B, QAT UD-Q4_K_XL (4.2 GB file) | q8_0 | 2,935 MiB | 3,043 MiB | 3,259 MiB |
| | f16 | 2,979 MiB | 3,115 MiB | 3,387 MiB |
| Qwen3.5-4B, Q6_K (3.5 GB file) | q8_0 | 3,843 MiB | 4,019 MiB | 4,371 MiB |
| | f16 | 3,941 MiB | 4,205 MiB | 4,733 MiB |
| Qwen3.5-9B, Q4_K_M (5.7 GB file) | q8_0 | about 5,780 MiB | about 5,920 MiB | about 6,190 MiB |

- The 9B row is llama.cpp's own account at load (weights 5,417 MiB, KV cache 272 MiB at 16k, recurrent state 38 MiB, compute 188 MiB). `nvidia-smi` rose by less (5,365 / 5,533 / 5,621 MiB) because the desktop's share shrank at the same moment.
- **Gemma 4 E4B is smaller on the card than its file:** 1.9 GB of per-layer embeddings stay in RAM and 2.5 GB of weights go to the GPU.
- **Context is cheap on these two architectures.** With the 8-bit cache, going from 8k to 32k costs 0.3 to 0.5 GB, because only 4 (Gemma 4 E4B) or 8 (Qwen3.5) layers keep a cache that grows with the context. The 8-bit cache itself saves 0.04 to 0.36 GB here: worth having, not decisive.
- On a classic 8B model the same step costs 3 to 4 GB (f16), so Llama 3.1 8B, Granite 4.2 8B or Ministral 3 8B at Q4_K_M would stop near 8k to 16k even on an empty 8 GB card, and do not fit beside this desktop.
- **What we can afford:** 32k for either 4B-class model. The pipeline needs 16k: no request holds more than one chapter and the notes. A larger context buys nothing here, and small models use it badly (see "Published quality figures").

**The 9B model does not fit beside the desktop.** With all layers on the GPU the card stood at 7.5 of 8.2 GB. The model ran at full speed for 13 minutes and then llama.cpp aborted with `CUDA error: an illegal memory access was encountered` (50 of the book's 62 units done). Its recaps were made in later, shorter sessions without a crash. Keeping layers on the CPU avoids the squeeze but costs most of the speed:

| Qwen3.5-9B Q4_K_M at 16k, layers on the GPU | GPU memory taken | Reading tok/s | Writing tok/s |
| --- | --- | --- | --- |
| 22 of 33 | 4,111 MiB | 1,355 | 13.7 |
| 26 of 33 | 4,625 MiB | 1,935 | 22.2 |
| 29 of 33 | 5,007 MiB | 2,242 | 37.5 |
| all | about 5,920 MiB | 3,162 | 87.3 |

## Speed

One 6,600-token prompt and 256 tokens of free text, all layers on the GPU, 16k context, q8_0 KV cache ([results/probes.jsonl](results/probes.jsonl)):

| Model | Reading (prompt) tok/s | Writing (generation) tok/s |
| --- | --- | --- |
| Gemma 4 E4B QAT Q4 | 7,435 | 106.5 |
| Qwen3.5-4B Q6_K | 4,640 | 107.2 |
| Qwen3.5-9B Q4_K_M | 3,162 | 87.3 |

- The pipeline's own figures, with schema-constrained output and prompts of every size, are in the results table. Constrained decoding did not slow generation.
- **A recap's time is its output.** Reading 4,000 to 9,000 tokens takes one to three seconds; the rest is writing each claim with its id and quote, about 75 tokens a claim. Assembled mode is faster because the model writes a third of the claims.
- **Latency need not be felt.** The cutoff is known when a session ends and the gap only grows, so a recap for each band can be made in the background while the reader is away.
- **The card can be given back.** A model loads from the page cache in 2 to 3 seconds, so the server can start for a job and stop after it; the alignment worker then has the whole card the rest of the time.

## Research (web, as of 20 November 2026)

Sizes, licences and layer counts below were read from Hugging Face's API and the models' `config.json` on 20 November 2026; the links are the model pages. Blog round-ups disagree with each other and are cited only where nothing better exists.

### Models that fit 8 GB

| Model | Released | Licence | File at Q4_K_M / Q5_K_M / Q8_0 (GB) | Layers whose KV cache grows with the context | KV cache per 1,000 tokens (f16) | Trained context |
| --- | --- | --- | --- | --- | --- | --- |
| [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) | Feb 2026 | Apache-2.0 | 2.74 / 3.14 / 4.48 | 8 of 32 (the other 24 are linear attention with a fixed-size state) | 31 MiB | 262,144 |
| [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B) | Feb 2026 | Apache-2.0 | 5.68 / 6.58 / 9.53 | 8 of 32 | 31 MiB | 262,144 |
| [Gemma 4 E4B](https://huggingface.co/google/gemma-4-E4B-it) | Mar 2026 | Apache-2.0 | 4.98 / 5.48 / 8.19 (about 1.9 GB of it is per-layer embeddings that stay in RAM) | 4 global; 20 more keep a 512-token window | 16 MiB | 131,072 |
| [Gemma 4 12B](https://huggingface.co/google/gemma-4-12B-it) | May 2026 | Apache-2.0 | 7.12 / 8.41 / 12.67 | 8 of 48 global; the rest a 1,024-token window | about 62 MiB (from its config) | 262,144 |
| [Granite 4.2 8B](https://huggingface.co/ibm-granite/granite-4.2-8b) | Aug 2026 | Apache-2.0 | 5.35 / 6.25 / 9.35 | 40 of 40 | 156 MiB | 131,072 |
| [Ministral 3 8B](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512) | Dec 2025 | Apache-2.0 | 5.20 / 6.06 / 9.03 | 34 of 34 | 133 MiB | 262,144 |
| [Llama 3.1 8B](https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct) | Jul 2024 | Llama 3.1 Community License (use restrictions) | 4.92 / 5.73 / 8.54 | 32 of 32 | 125 MiB | 131,072 |
| [Phi-4-mini](https://huggingface.co/microsoft/Phi-4-mini-instruct) (3.8B) | Feb 2025 | MIT | 2.49 / 2.85 / 4.08 | 32 of 32 | 125 MiB | 131,072 |

- **Meta has released no small Llama since 3.1 8B and 3.2 3B** (2024); Llama 4 is two large mixture-of-experts models. Microsoft's small line is still Phi-4-mini.
- **Gemma 4 changed licence:** Gemma 3 used Google's own Gemma terms, Gemma 4 is Apache-2.0 ([model card](https://huggingface.co/google/gemma-4-E4B-it)). Every model worth shortlisting is now Apache-2.0 or MIT.
- **Qwen3.5 and Gemma 4 reason by default.** Both must be told not to. Gemma 4 kept reasoning under llama.cpp's `--reasoning off` and spent its reply on it, until `--reasoning-budget 0` was added.
- GGUF files: [unsloth/Qwen3.5-4B-GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF), [unsloth/Qwen3.5-9B-GGUF](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF), [unsloth/gemma-4-E4B-it-qat-GGUF](https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF) (from Google's quantisation-aware checkpoint; Google's own [q4_0 file](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf) is 5.15 GB), [ibm-granite/granite-4.2-8b-GGUF](https://huggingface.co/ibm-granite/granite-4.2-8b-GGUF), [mistralai/Ministral-3-8B-Instruct-2512-GGUF](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512-GGUF).

### Runtimes

| Runtime | JSON-schema output | KV-cache quantisation | For this host |
| --- | --- | --- | --- |
| **llama.cpp server** ([server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)) | `response_format` with a JSON schema, or `json_schema`, converted to a grammar that masks tokens while decoding ([grammars README](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)). A subset of JSON Schema: `pattern`, `enum`, `minItems`/`maxItems`, `minLength`/`maxLength` work, some `anyOf`/`oneOf` shapes do not. | `--cache-type-k` / `--cache-type-v`: f16 (default), q8_0, q4_0 and others; needs flash attention. | Releases now include prebuilt Ubuntu CUDA binaries and the CUDA runtime, so it installs in a home folder without sudo. Runs Qwen3.5's hybrid layers and Gemma 4 E4B. Returns timings per request. **Used here.** |
| **Ollama** 0.40 ([structured outputs](https://docs.ollama.com/capabilities/structured-outputs), [FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.mdx)) | `format` with a JSON schema, constrained while decoding; also `response_format` on its OpenAI-compatible API. | `OLLAMA_KV_CACHE_TYPE` f16 / q8_0 / q4_0 with `OLLAMA_FLASH_ATTENTION=1`; one setting for every model. | A 1.5 GB tarball that can also run from a home folder. It loads and unloads models itself (`keep_alive`), which suits a shared card, but gives less control over the grammar, the reasoning switch and what is on the GPU. A reasonable second choice. |
| **ExLlamaV3 + TabbyAPI** ([ExLlamaV3](https://github.com/turboderp-org/exllamav3), [TabbyAPI](https://github.com/theroyallab/tabbyAPI)) | JSON schema, regex and EBNF. | 2 to 8 bit cache quantisation. | EXL3 quantisation (based on QTIP) keeps more quality per bit than GGUF's Q4, which would matter for squeezing a 9B model. It supports Qwen3.5 but lists Gemma 4 E2B/E4B as unsupported, and needs its own PyTorch environment of several GB. Not installed. ExLlamaV2 is its predecessor. |
| vLLM, TGI, TensorRT-LLM | Guided decoding. | – | Built for many parallel requests on large cards; nothing to gain for one request at a time on 8 GB. Not considered further. |

- All three shortlisted combinations were measured on llama.cpp: it is the one runtime that runs both architectures here without sudo, and a second runtime would have measured the same weights.
- Constrained decoding guarantees the shape of the output, not its truth. [JSONSchemaBench](https://arxiv.org/abs/2501.10868) compares engines' schema coverage and finds that constrained decoding can also be faster than free generation.
- q8_0 KV cache: Ollama's FAQ calls the loss "very small" and recommends it when not using f16; q4_0 is "small-medium" and more visible at long contexts. llama.cpp builds since April 2026 rotate the cache before quantising it, so older quality comparisons do not carry over ([note](https://particula.tech/blog/kv-cache-quantization-accuracy-loss-benchmarks)); the build used here logs that rotation.

### Published speed figures

No source gives a measured llama.cpp row for the 3070 Ti with both prompt and generation speed. What exists:

- llama.cpp's own [CUDA results thread](https://github.com/ggml-org/llama.cpp/discussions/15013) lists neighbouring cards (3080, 3090 Ti, 4060 Ti).
- One guide measures about 80 tokens/s for Qwen3-8B at Q4_K_M on an RTX 3070 ([markaicode](https://markaicode.com/benchmarks/llamacpp-tokens-per-second-benchmark/)).
- Calculator sites put a 7–8B model at Q4_K_M on the 3070 Ti anywhere from 25 to 88 tokens/s ([llmrun.dev](https://llmrun.dev/gpu/rtx-3070-ti), [apxml.com](https://apxml.com/hardware/rtx-3070ti-8gb), [promptquorum](https://www.promptquorum.com/prompt-bites/best-models-amd-5700x-3070ti)); these are estimates.

The measurements in this document replace them.

### Published quality figures

- **Faithfulness of short summaries.** [Vectara's hallucination leaderboard](https://github.com/vectara/hallucination-leaderboard) (updated 22 October 2026) measures unsupported facts in summaries of short documents. Small models on it: Qwen3-8B 4.8%, Qwen3-4B 5.7%, Gemma 3 12B 4.4%, Gemma 3 4B 6.4% (but it answered only 67% of the time), Gemma 4 26B-A4B 5.2%; the Qwen3.5 family 10.5–12.1% (27B, 35B-A3B and the hosted Flash and Plus); Ministral 3 8B 21.7%, Phi-4-mini 23.5%, Ministral 3 3B 24.2%. Qwen3.5-4B, Qwen3.5-9B and Gemma 4 E4B are not listed. Two things follow: Ministral 3 and Phi-4-mini are out, and the Qwen3.5 family is not more faithful than Qwen3 on this test. The fixture agrees: the Qwen3.5 models made the wrong claims, Gemma 4 did not.
- **Book-length summaries.** [FABLES](https://arxiv.org/abs/2404.01261) had readers check 3,158 claims in LLM summaries of 26 recent novels. Even the best model made unfaithful claims; most concern events and the states of characters and relationships, and need several passages to refute. Models used as judges could not find the unfaithful claims reliably. A later re-annotation found 14% of the claims not fully supported ([VeriTrail](https://arxiv.org/abs/2505.21786)). No small open-weight model was in the study.
- **Long-context recall.** In [NoCha](https://arxiv.org/abs/2406.16264) (true and false claim pairs about whole novels) no open-weight model did better than chance, and models use the middle of a long context worst ([Lost in the Middle](https://arxiv.org/abs/2307.03172)). This is the reason not to hand a small model the whole prefix, even where the memory allows it.
- **Citation with quotes.** I found no benchmark of verbatim-quote citation for models of this size; the prototype measures it.

The design under test needs none of the long-context ability: no request holds more than one chapter and the notes. What it does need is exact reading of a few thousand words, which is what the fixture and the real book test.

### Shortlist

| Model × quantisation × runtime | Why |
| --- | --- |
| Gemma 4 E4B × QAT 4-bit × llama.cpp | The smallest on the card; the Gemma line scores best of the small models on faithfulness. |
| Qwen3.5-4B × Q6_K × llama.cpp | The same size class from the other family, at a higher-precision quantisation that still fits. |
| Qwen3.5-9B × Q4_K_M × llama.cpp | The largest model that could fit 8 GB with a useful context, to see what size buys. |

## What is left on the WSL host

Everything is under `~/recap-proto` (14 GB). No model server is running and the GPU memory is back to what the desktop uses. Nothing outside that folder was changed: no sudo, no service, no Windows-side change, and `~/sonder-ctc-worker` was not touched.

| Path | Size | What |
| --- | --- | --- |
| `models/` | 13 GB | The three GGUF files (4.0, 3.3 and 5.3 GB). |
| `llama/b12589/` | 0.9 GB | llama.cpp and its CUDA runtime, unpacked. |
| `work/sonder/` | 0.3 GB | A copy of this branch with `node_modules`. |
| `work/runs/` | 2 MB | The final outputs, the real book's notes and recaps among them. |
| `work/books/` | 3 MB | The fixture and a copy of the *Dungeon Crawler Carl* EPUB with its extracted sentences. |
| `wsl/`, `logs/` | under 1 MB | Scripts and logs. |

To read the real book's recaps: `~/recap-proto/wsl/show.py ~/recap-proto/work/runs/gemma4-e4b-qat-q4 dcc1 --assembled` (or `qwen35-9b-q4 dcc1` for the 9B model's). To remove everything: `rm -rf ~/recap-proto`.

## Limits of this measurement

- **No hosted model was run** (no paid calls), so "is a hosted model better" is answered from the panel's bars and published results, not from a side-by-side.
- **One reader judged**, and for the real book only a sample. The panel's plan (a calibrated judge model, then the owner) is still to do.
- **Twenty-four recaps per model.** Rates from so few are rough.
- **Other work ran on the host** during the measurements: CI checks on the CPU and the owner's desktop on the GPU. Speeds moved by a few percent between runs.
- **The fixture is tiny,** so the gap bands step down on it: a recap is at most a fifth of the words read, and only its last position reaches the 300–400 word band. The 450–550 word band was measured on the real book only.
- **The stored notes were made before one late fix.** Qwen3.5 leaves a person's name out of a "who" note because the name has its own field, and later summarising steps saw those notes without the name. The name is now put back wherever a note is shown. The recaps in this document were made after the fix, the notes before it.
- **llama.cpp nightly.** An earlier pass, with another output schema, failed once on each Qwen model within a book with `Unexpected empty grammar stack` (HTTP 500); the client now asks again with another seed. The final pass had none.
- **Dropped as unusable:** letting the same model judge whether each cited passage supports its claim. It filled its reasoning field with a copy of the claim and rejected most claims that reading shows to be right. A judge needs a stronger model or labelled examples.

## What to change next

- **Run the panel's evaluation with a hosted model beside these**, on the same notes and cutoffs. The pipeline only needs another address in `llm.ts`.
- **Spread the stored events better:** at most a few per chapter among the latest ten, so that one fight cannot fill them.
- **Leave front matter and back matter out** of the units (the copyright line became a note).
- **Retire goals by code** when a later chapter's notes contradict them, or drop the stored goals older than a chapter.
- **Let a claim that comes from a note name the note** instead of copying its id and quote: about a third fewer tokens per claim in written mode.
