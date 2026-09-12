# Copy Source Action Passages in Means

Artifact-Version: 1
Status: Approved

## Intent

Reduce repeated action prose generation and paraphrase drift under [the complete player objective](0122-player-action-efficiency.md). Recent complete planning outputs devote 14–21 KB to means descriptions. This is a byte measurement, not a token saving or semantic qualification.

## Contract

An independently configured physical planning adapter adds an action-local inventory of exact original rawText, goal and non-null means texts and their punctuation-delimited passages. Original complete contexts remain unchanged. Deduplication compares exact strings only. Each passage retains its source field and offsets; punctuation and whitespace are preserved. Splitting is a copy convenience, never a semantic segmentation or a determination that a prerequisite is satisfied.

A means description may remain any originally valid string or explicitly select one local passage with {copy: integer}. The decoder copies that exact string for the assigned action and changes nothing else. It does not choose sources, paraphrase, concatenate clauses, drop conditions, infer completion, fix historical strings, or turn intended actions into evidence that they happened. Invalid indices, mixed forms and extra properties remain rejected. Original means sources, order, repetition, plan targets, factors, causes, effects, modes and canonical validation remain authoritative. Full original text is always available as a copy choice; novel descriptions and legitimate interpretations remain expressible as strings.

The source, original assigned action, passage provenance, candidate context and schema bind the decoder. Valid neighboring slots remain independently recoverable through the original coordinator. Rating-owned opposition, self-condition and hierarchical relation experiments remain disabled. No gameplay composition enables this candidate.

## Plan

Implement one benchmark adapter. Verify exact source text coverage, canonical historical round trips and original rejection preservation through the real gateway, coordinator and materializer. Freeze one initial complete 49-action/11-slot B/C feasibility pair on current committed code, at most two HTTP calls, DeepSeek Flash with thinking disabled, one transport attempt and a 240-second timeout. Do not repair, continue, resample or execute a world step in this screen. Compare original action coverage and means-source relevance after decoding, not text length alone.

## Verification

Exercise Unicode, punctuation, whitespace, repeated passages and means, differing action triplets, cross-action isolation, malformed and missing selectors, source mutation, exact free-string retention, current interval instructions and valid neighboring slots. Run focused tests and check:fast before committing and dispatch. Record input/output/cache tokens, copy use, literal fallback, all gateway/materializer errors and source-semantic counterexamples. One pair cannot establish reliability, causal acceleration or full-player completion.

## Evidence

[Decision 0190](../decisions/0190-copy-exact-action-passages-for-means.md) records the alternatives and research basis. [Action-local means positions](0087-action-local-means-indices.md) retain ownership of evidence selection.
