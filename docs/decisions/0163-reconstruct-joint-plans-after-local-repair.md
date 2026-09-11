# Reconstruct joint plans after local repair

## Status

Accepted
Class: architecture

## Context and Problem Statement

The deterministic materializer reports plan-local failures with complete joint scope. Regenerating every plan in the component repeats valid work, while independently accepting repaired plans would miss constraints between replacements and retained drafts.

## Decision Drivers

- Preserve complete source evidence, action freedom and atomic commits.
- Reduce repeated generation without additional repair rounds.
- Keep ownership, source binding and cross-plan validation observable.

## Considered Options

- Regenerate the complete component after every failure.
- Accept independently validated replacement plans.
- Reconstruct the full draft set after scoped generation and revalidate jointly.

## Decision Outcome

Use reconstruction followed by complete joint validation as an opt-in experimental recovery strategy. Select a strict subset only from unambiguous plan ordinals in a complete typed candidate, including its transitive proposal declaration/reference dependencies. Keep full recovery for failures without that evidence. This changes repair output responsibility, not the first batch or world scope.

## Pros and Cons of the Options

Complete regeneration is straightforward but repeats output for unaffected plans. Independent acceptance reduces generation but misses cross-plan constraints. Reconstruction retains the generation reduction and preserves joint validation, at the cost of explicit candidate binding, merge auditing and fallback handling. Retained drafts still await semantic review and cannot produce early world commits.

## Links

- [Scoped repair contract](../specs/0113-scope-mechanical-plan-repairs.md)
- [Materialization and validation boundary](../../src/engine/mechanics/truth-engine.ts)
- [Existing bounded repair loop](../../src/engine/models/semantic-repair.ts)
