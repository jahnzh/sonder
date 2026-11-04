# Jev and orchestration dispatch research

Research for issue #87, 2026-10-29. This is a feasibility assessment, not an implementation or a live evaluation.

## Which Jev?

The request does not identify a product. No `jev`, `jev-codex`, or `jev-claude` executable was on this session's PATH, and searches of the repository's agent docs and scripts and the local agent skill directories found no relevant Jev integration. This is not proof that the user has no account or installation elsewhere.

- [TypeSafe's Jev](https://docs.typesafe.ai/introduction) is a hosted structured decision model. It can classify and score task descriptions, but it does not generate code, run an agent, or fetch subscription quotas. Its API evaluates the state provided in the request; `usage` in its response is token usage for that Jev request, not usage of other providers. [Coding-agent guidance](https://docs.typesafe.ai/introduction/coding-agents), [API reference](https://docs.typesafe.ai/api/system-one).
- [mynameisjev](https://github.com/bradsec/mynameisjev) is a third-party Claude Code plugin that uses TypeSafe Jev to size messages and separately uses usage data to suggest Claude/Codex routing. Its documented scope is Claude Code message routing, not Orca worker dispatch. It is evidence of a possible design, not evidence of an existing integration here.
- [jevrouter](https://github.com/mdimamhosen/jev) is a different third-party gateway, distributing a `jev` CLI and routing requests to provider APIs. Its model gateway is not the same product as TypeSafe's decision model, and its README does not establish that it can select among the owner's existing subscriptions for Orca workers.

Confirm the intended product before choosing an implementation.

## If TypeSafe Jev is intended

The [System One API](https://docs.typesafe.ai/api/system-one) accepts a model name, supplied state, and named questions. [Choice](https://docs.typesafe.ai/primitives/choice) returns a selected fixed option, per-option probabilities and confidence; [Score](https://docs.typesafe.ai/primitives/score) returns a position on an ordered rubric and associated probabilities/confidence. TypeSafe recommends breaking complex judgments into narrow independent questions and combining answers in code, rather than asking a single multi-factor question. [Introduction](https://docs.typesafe.ai/introduction), [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring).

A candidate design, still to validate:

1. A coordinator gathers a minimal task summary and an allowlist of agents, models, effort settings and subscription availability from separately verified sources. The TypeSafe API does not itself provide live Claude, Cursor, Codex or Antigravity usage.
2. Use Jev for narrow subjective judgments such as task complexity; apply deterministic capability, availability, quota freshness and project policy checks in the coordinator. A `choice` over eligible options with an explicit abstain option is another candidate. Preserve the explicit `--model` and launch-receipt checks in `scripts/orca-spawn.sh`.
3. If data is missing, stale, contradictory, or the result is uncertain, fall back to the coordinator's documented selection; never interpret missing quota as available. Record sources, timestamps, candidate set, decision and reason without credentials or task secrets.
4. Compare recommendations on a representative labelled set against the existing manual selection, including difficult tasks, invalid candidates, low capacity, stale/missing data and Jev/network failure. Confidence is derived from the returned probability distribution; it is not proof that a particular answer is correct. [Confidence](https://docs.typesafe.ai/confidence), [confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing).

This is a proposed architecture, not a verified performance claim or an endorsed threshold. No quota data source, account permissions, wiring to Orca, or correctness of the ranking has been established.

## API and operating considerations

- TypeSafe uses `POST https://api.typesafe.ai/v1/systemone` with bearer authentication. The [quickstart](https://docs.typesafe.ai/introduction/quickstart) documents API-key setup and SDKs. Don't put credentials or private repository data into an issue, logs, or an external request without considering the chosen service's data-handling terms.
- The [model reference](https://docs.typesafe.ai/models) listed Jev 1.14 at $0.042 per million input tokens, output free, when checked; prices and aliases can change. The `jev-latest` alias moves as releases change. Record the returned version, and evaluate pinned versions before changing any tuned thresholds.
- No live call was made: account access, actual subscription-quota availability, latency, cost for this workload and dispatch benefit remain unmeasured. Third-party routing tools and their configuration should be assessed separately before installation or credential access.

## Orca harness integration seam

The repository's `scripts/orca-spawn.sh` currently invokes `orca orchestration worker-start` with explicit `--agent`, `--model`, optional `--effort`, spec and placement, and checks the effective model in its receipt. [`docs/agents/worker-spec.md`](https://github.com/jahnzh/sonder/blob/main/docs/agents/worker-spec.md) records the choice. An adapter ahead of that launch could accept a bounded task summary, eligible `(agent, model, effort, subscription)` candidates and timestamped quota snapshots; return a selected candidate or an explicit unavailable/abstain result plus provenance and reason; and pass only valid agent/model/effort flags to the existing wrapper. The actual wrapper does not expose a subscription selection flag. Determine which agent credentials/profile Orca uses and whether it supports selecting or verifying a subscription before promising account-level routing; selecting a model alone does not prove which account pays.

Build and test the seam against the version-matched Orca CLI and mocked Jev/quota providers, preserving the current preflight, CodeGraph setup and receipt checks. Quota snapshots should have a source and observed time, distinguish exhausted from unknown, expire after an explicitly chosen freshness interval, and never embed credentials in the Jev request or launch logs. Confirm supported sources and their permission model per provider rather than assuming one general endpoint. Validate stale/missing data, malformed or unavailable Jev responses, no eligible candidate, unsupported models, receipt mismatch and launch failures; do not launch a worker twice just because a receipt is uncertain. Use manually labelled real task examples to evaluate routing before any automatic dispatch.

The version-matched `orca orchestration worker-start --help` exposes `--agent`, `--model` and `--effort`, but no subscription/account flag. The version-matched coordinator guide says to pass a model only when the user names one, whereas this repository’s `AGENTS.md` requires explicit model selection for workers; resolve that workflow difference for the intended installation before automating overrides. The CLI also says model and effort cannot be applied when reusing `--terminal`, and a remote worker server must advertise launch-preference support.

The current wrapper can exit nonzero after a worker has already started when the effective model differs or the receipt cannot be parsed. A caller must inspect the receipt and Orca’s recovery state before retrying; treating every wrapper failure as proof that no worker exists can duplicate a launch.
