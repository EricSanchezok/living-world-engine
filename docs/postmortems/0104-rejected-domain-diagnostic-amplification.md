# Repeated Rejected Domains Exhausted Repair Context

Artifact-Version: 1

## Executive summary

A full-world diagnostic passed action compilation but stopped during planning repair before committing state. Repeated copies of complete rejected cause domains made two repair requests exceed the model context window. The model had not received those oversized requests.

## Summary

An invalid cause selection retained its complete historical domain in each rejected plan. Validation issues also retained the original plan as evidence. One physical repair context contained eighteen copies of the same domain. Root-batch limits and repair bisection did not bound repeated evidence within an individual logical slot.

The optional planning representation now shares identical complete historical arrays and registers every replaced location. It preserves current legal choices, diagnostic reasons, issue paths, old index meanings and all historical rows. Exact inverse checks cover the entire source state. This is a representation change requiring separate model and full-game validation; smaller input does not establish semantic correctness or gameplay latency.

## Timeline

- A full-world diagnostic recovered one rejected compilation batch and reached planning and independent verification.
- Planning repair requests exceeded the context window without dispatching HTTP.
- Ledger lineage and serialized context exposed repeated historical domains in previous outputs and validation issues.
- An offline decomposition restored the full source exactly while removing duplicate arrays.
- The planning adapter gained a versioned sharing contract and gateway-level regression coverage.

## Root cause

Complete rejected-domain evidence is necessary when repair narrows or reorders the current scope. Storing the entire domain independently in every malformed plan, then copying those plans into validation issues, multiplied an otherwise recoverable error's input size. Existing correctness tests covered preserved identity but did not exercise large repeated domains through the physical request path.

## Guardrails

- [Diagnostic-domain tests](../../src/engine/mechanics/__tests__/repair-diagnostic-domains.test.ts) cover complete reconstruction, narrowed repair, distinct domains, source drift, malformed references, marker collisions and unchanged non-repair data.
- [Planning adapter tests](../../src/engine/mechanics/__tests__/planning-catalog-encoding.test.ts) send real physical batches through the gateway with only model HTTP replaced, checking restored logical contexts, output validation and pinned representation identity.
- [The sharing contract](../specs/0099-share-rejected-cause-domains.md) requires full-body token admission and source reconstruction before a new paid diagnostic. Historical requests and failed runs remain evidence.
- [Decision 0160](../decisions/0160-share-complete-rejected-domains.md) rejects evidence truncation, increased thinking and subdivision as substitutes for removing duplicate representation.

## Remaining limitations

Sharing arrays does not deduplicate diagnostic strings or prevent arbitrarily large unique evidence. The source cause-selection error remains invalid and still requires repair. Recorded canonical schemas can have a different field order from the original HTTP schema text; reconstructed-body token comparisons must disclose any difference from historical admission counts and must not be described as byte-exact HTTP replay.
