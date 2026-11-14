# Generate shared book knowledge from prefixes of the selected EPUB

Book knowledge is tied to the EPUB edition the user selects, with generated artifacts reused for identical text; choosing another edition requires matching or regenerating the knowledge so citations and cutoffs stay meaningful. Extract facts forward through the text, exposing each generation step only to its prefix, and retain when each fact becomes available rather than generating full-book biographies and trying to remove spoilers afterward.

Later identity revelations, identity links and summaries must not change earlier views. This requires additional provenance and versioned knowledge views but enables shared extraction for chat, the glossary and the graph without deliberately supplying later source text to earlier generation steps; pretrained model knowledge remains a separate limitation.
