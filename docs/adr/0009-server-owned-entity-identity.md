# The server owns knowledge entity identity

Extraction never creates entity identifiers. For each chunk, the server supplies the knowledge entities whose names, as established in earlier chunks, occur in that chunk's text. The model either reuses one of them or proposes a new one. The server validates every reference, rejects unknown ones and assigns a stable identifier to each new entity. A coverage rule requires every named character, place, group, important object or unfamiliar term in the chunk to become an entity, whether new or reused.

Identity links come from two sources, and each records which one it is:
- **Story revelation.** The text establishes that two known entities are one. Extraction proposes the link like any other fact, subject to the same evidence and availability rules.
- **Extraction correction.** Extraction recorded the same entity twice. A deterministic resolver links the two only on conservative rules:
  - an identical full name;
  - a given name that is unique at that position;
  - an identical titled name whose remainder is a given name ("King Robert");
  - for places, groups and objects, an identical proper name, whatever type extraction gave it.

  The resolver never links on a family name or title alone ("Lord Stark"). Any relationship between the two entities other than an identity link rules out linking them.

Ambiguous cases go to a model judgement that sees only the text up to that position. A reused identifier that turns out to cover two entities is split. Links and splits are versioned events that are available no earlier than the end of the chunk that introduced the later entity or the evidence. Stored identifiers are never rewritten (ADR 0008).

Automatic corrections target at least 99% precision, measured against a labelled set of entity pairs. A wrong link mixes two characters' facts and can reveal a later identity, whereas a missed duplicate only fragments the view.

## Considered options

- **Model-created identifiers with a window of recent entities** (the first prototype). This failed as the cast grew. In *A Game of Thrones* it produced 239 names with several identifiers, one character with 11, and generic identifiers reused for unrelated characters.
- **Cleanup after extraction only.** This leaves the cause in place and depends on rules or model judgements for every repeat. In the same run, 96% of duplicates (516 of 538) arose in a chunk whose text already contained a known name of the entity, so supplying that entity prevents them at about the same request size.

## Consequences

- Extraction requests carry a registry of known entities retrieved by name, not by recency, and limited to names available in that step's prefix.
- A chunk that introduces many entities needs a fact budget that listing them does not consume. With a shared budget, one prototype run over 29 chunks produced 18% fewer facts.
- Every view applies only the identity links and splits available at its knowledge cutoff.
- Measurements: issue #378, prototype comment of 13 November 2026.
