# Action Compilation graph-aware candidate retrieval

## Status

Superseded by [0100](0100-promote-relational-rrf-and-refresh-reference-data.md)
Class: architecture

## Context and Problem Statement

Action Compilation currently gives the model a large closed candidate catalog.
The frozen FullCatalog behavioral benchmark contains 46 accepted slots and 609
required candidate keys. A 20% shortlist is desirable for context cost, but a
lexical shortlist misses a material number of state and fact references.
Candidate selection therefore needs structural evidence without weakening the
authoritative resolver or changing the benchmark's historical schema.

## Decision Drivers

- Preserve strict kind, use, scope, schema, semantic, and transaction gates.
- Make candidate selection deterministic and reproducible from a catalog hash.
- Use graph relations to enrich, rather than blindly expand, lexical matches.
- Keep offline evaluation free of LLM, network, and world mutations.
- Allow local encoder and lightweight ranker experiments without making a
  small benchmark look like production truth.
- Keep the complete pre-shortlist context available for capture and replay.

## Considered Options

- Keep FullCatalog everywhere and accept the context cost.
- Use global fuzzy or top-k string matching over candidate keys.
- Expand an untyped graph with unrestricted BFS and silently increase the
  shortlist when anchors do not fit.
- Use a typed, role-constrained relation graph with lexical/encoder signals,
  fixed budget selection, strict fail-closed middleware, and FullCatalog as the
  default control path.

## Decision Outcome

Use a catalog-hash-indexed relation graph for offline Action Compilation
retrieval. Seeds are action, actor/entity, unique targets, eligible temporal
profiles, and visible perspective aliases. Paths are constrained by field role
and candidate kind/use; relation priority, alias/BM25F, local multilingual-E5
signals, and optional deterministic pairwise-linear ranking are combined before
coverage-aware selection at a fixed 20% budget. No automatic FullCatalog
fallback or implicit budget expansion is allowed.

The production integration is an opt-in middleware. It passes a cloned,
shortlisted model context to the gateway while the authoritative resolver keeps
the complete catalog. Missing anchors, invalid/private keys, over-budget
shortlists, and post-validation failures remain failures and follow the existing
repair/rollback path. A deterministic 30% instance canary is available, but the
default remains FullCatalog until offline gates and replay evidence pass.

The full context and exact pre-step state can be captured before middleware for
future FullCatalog regeneration. Frozen benchmark versions are never modified;
regeneration creates a new version and uses the existing schema/materialization
and semantic validation path.

## Pros and Cons of the Options

### FullCatalog

- Good: maximum recall and semantic visibility.
- Bad: context grows with the world and does not test scalable retrieval.

### Global fuzzy matching

- Good: simple and sometimes repairs transcription errors.
- Bad: has no role, scope, or kind guarantee and can silently select a
  semantically unrelated object.

### Unrestricted graph BFS

- Good: exposes more related state.
- Bad: graph degree and depth consume the budget with irrelevant neighbors and
  can leak slot-private candidates.

### Typed graph plus staged signals (selected)

- Good: deterministic, auditable, role-aware, and compatible with strict
  resolver validation; lexical and local encoder signals remain useful for
  facts with sparse explicit relations.
- Bad: a 46-case behavioral benchmark is not enough for a promotable learned
  model, and some difficult facts will remain missing until more snapshots are
  captured.

## Links

- [BLINK](https://github.com/facebookresearch/BLINK)
- [NCEL](https://aclanthology.org/C18-1057/)
- [RAT-SQL](https://aclanthology.org/2020.acl-main.677/)
- [Robust Candidate Generation](https://aclanthology.org/2022.wnut-1.8/)
- [GraphRAG local search](https://github.com/microsoft/graphrag/blob/main/docs/query/local_search.md)
- [mE5 technical report](https://arxiv.org/abs/2402.05672)
- [0096 — Versioned behavioral benchmark datasets](0096-versioned-behavioral-benchmark-datasets.md)
- [0100 — Promote relational RRF and refresh reference data](0100-promote-relational-rrf-and-refresh-reference-data.md)
