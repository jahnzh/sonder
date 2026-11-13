# The server owns knowledge entity identity

Extraction never creates entity identifiers. For each chunk, the server supplies the already known knowledge entities whose names occur in that chunk's text, and the model either reuses one of them or proposes a new one. The server then validates every reference, rejects unknown ones and assigns a stable identifier to each new entity. An explicit coverage rule requires every named person, animal, place, group or object in the chunk to become an entity, whether new or reused.

Duplicates that slip through are resolved by conservative rules and recorded as identity links with the position from which they apply, never by rewriting stored identifiers (ADR 0008):
- An identical full name, or a given name that is unique at that position, becomes a link.
- A family name or a title on its own ("Lord Stark") never becomes a link automatically.
- A relationship between two entities rules out linking them.

Only ambiguous cases go to a model judgement, which sees only the text up to that position. A wrong link mixes two characters' facts and can reveal a later identity, whereas a duplicate only fragments the view, so precision is preferred to recall.

## Considered options

- **Model-created identifiers with a window of recent entities** (the first prototype). This failed as the cast grew. In *A Game of Thrones* it produced 239 names with several identifiers, one character with 11, and generic identifiers reused for unrelated characters.
- **Cleanup after extraction only.** This leaves the cause in place and depends on rules or model judgements for every repeat. In the same run, 96% of duplicates arose in a chunk whose text already contained a known name of the entity, so supplying that entity prevents them at about the same request size.

## Consequences

- Extraction requests carry a registry of known entities retrieved by name, not by recency. A chunk that introduces many entities needs a fact budget that is not consumed by listing them; with a shared budget the prototype lost 18% of its facts.
- Identity links are versioned knowledge facts. Every view applies only the links available at its knowledge cutoff.
- Measurements: issue #378, prototype comment of 13 November 2026.
