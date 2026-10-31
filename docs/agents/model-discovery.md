# Model discovery

Use model discovery to compare provider offerings with the first, verified table in `docs/agents/models.md`. Discovery never launches a worker or changes that table. Run the commands from the repository root:

```bash
node scripts/orca-models.mjs list
node scripts/orca-models.mjs list --json
node scripts/orca-models.mjs diff
node scripts/orca-models.mjs verify antigravity/claude-sonnet-5-5-medium
node scripts/orca-models.mjs verify antigravity/claude-sonnet-5-5-medium --base main --write /tmp/model-verification
```

`list` runs `agy models`, `agent --list-models` and `opencode models`, checks Claude and Codex help for a models subcommand, and lists documented rows when no provider list is available. OpenCode falls back to its local installation when it is absent from PATH. It marks only the configured supported model usable; built-in OpenAI models are flagged as lacking credentials and are never candidates. Each provider has a 30-second deadline; a failed provider does not prevent the others from being shown. The Cursor count includes effort variants, and the separate Cursor Models bucket list comes from the collector's model scope. Without a usable scope, named Cursor models can remain unmapped. The command exits successfully even when an individual provider is unavailable, so check each provider's status or message.

`diff` compares offerings with the recommender's verified table parser. Each line shows `verified` and its capability, or `UNVERIFIED`, followed by quota window or bucket ids and the per-candidate usage status. It reads the latest usable collector observations without refreshing providers; no reading, an expired reading, or a failed account check cannot establish capacity. `UNMAPPED` means the readers could not match a model to quota windows, not that quota is free. `STALE ROW` means a successful provider list omitted a verified row. If the provider list failed, the row instead says `LIST UNAVAILABLE`; Claude and Codex documented-only lists cannot establish that rows are stale.

`CANDIDATE` marks an unverified offered model whose mapped bucket has a fresh reading with capacity (`fresh` or `low`). Low capacity can be below the routing safety floor. This is a discovery hint, not a recommendation: it does not apply owner policy, prove the effective model, or guarantee a launch. Cursor's `included_auto` bucket is the Cursor Models allowance; `included_api` is Other Models, and the parent Plan allowance also affects the per-model assessment. Antigravity windows such as `gemini-weekly`, `3p-weekly`, and `gemini-argon-wtu-weekly` are distinct. See `docs/agents/models.md` and `docs/agents/usage-collector.md` for bucket and freshness details.

## Verify a model

1. Run `verify <agent>/<model>`, optionally selecting a base with `--base`. It prints a read-only spec and an exact `scripts/orca-spawn.sh` command but starts nothing and writes nothing. Save the spec at the printed path, or use `--write <dir>` to create it; an existing spec is never overwritten.
2. A coordinator separately runs the printed command when ready, checks the launch receipt's **effective** model against the requested id, and checks the worker's report. The spec asks for the first 12 lines of `AGENTS.md`, `git log -1`, `node -v`, and the effective model id; it asks for no changes. Follow the preflight and receipt recovery rules in `docs/agents/worker-spec.md`.
3. Add a model row only after a real launch check shows the requested effective model. Record the verified effort and date, update the quota-bucket notes, and assign `mechanical`, `standard`, or `reasoning-heavy` by judgment against the three tiers in `docs/agents/models.md`. A listing or a quota mapping alone is not verification.

On 2026-10-31, one real read-only launch each verified `antigravity/claude-sonnet-5-5-medium` and `antigravity/claude-opus-5-5-high`: the receipts showed the requested effective models and the workers reported their model ids. Their table capabilities are `standard` and `reasoning-heavy`, respectively.
