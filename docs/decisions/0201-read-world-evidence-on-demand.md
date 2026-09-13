# Read World Evidence on Demand

## Status

Accepted
Class: testing

## Context and Problem Statement

Complete-input perception experiments retain role confusion, invented communication and incorrect exclusion of direct participants. Smaller assignments and lower sampling temperature do not qualify a complete response. The source contains a large reference catalog and canonical tables, while its current interface requires all values to accompany every inference. The cause of each semantic error is not established by input size alone.

## Decision Drivers

- Preserve the complete world, arbitrary actions and canonical validation.
- Make every advertised record actually retrievable from the immutable source.
- Test a different execution strategy and account for its additional calls.
- Distinguish readable evidence from a model's correct use of that evidence.

## Considered Options

1. Continue supplying every source value in every perception call.
2. Expose a complete directory and deterministic read interface with an initial exact working set.
3. Select a fixed subset of relevant records and make the remainder unavailable.

## Decision Outcome

Select option 2 for a bounded experimental reader, with full-context retrieval as an explicit operation. Canonical tables remain immutable, successful reads retain exact values, and terminal citations require those values to have been loaded. The original gateway validates against the complete catalog, while actual wire bodies and read costs remain visible. This accepts a diagnostic interface and its comparison protocol, not default runtime integration or semantic equivalence.

## Pros and Cons of the Options

Option 1 minimizes retrieval calls and retains direct access but supplies all records repeatedly and has not qualified current model behavior. Option 2 can reduce initial context and lets the model request evidence, but adds sequential inference, retrieval-selection errors and the risk of missing an uncited cause. Option 3 has a simpler fixed cost, but mistakes in relevance selection become inaccessible evidence and repeat the historical context-omission failure. Explicit reads preserve availability without proving that the model will request everything it needs.

## Links

- [Experiment contract](../specs/0155-demand-read-perception-evidence.md)
- [Complete perception foundation](../specs/0105-complete-onset-perception-context.md)
- [MemGPT, sections 2.1–2.4](https://arxiv.org/html/2310.08560v2): motivates explicit movement from external storage into model context and function-based control flow. This experiment uses only immutable reads, with no memory rewriting, eviction or transferred benchmark guarantee.
- [ReAct](https://arxiv.org/abs/2210.03629): motivates acquiring additional information through environment actions. The experiment keeps thinking disabled and does not implement or inherit the paper's reasoning-trace method or scores.
