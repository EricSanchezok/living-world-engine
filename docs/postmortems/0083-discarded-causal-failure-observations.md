# Discarded Causal Failure Observations

Artifact-Version: 1

## Executive summary

A full-world transition repeatedly asserted that an existing entity was absent. The deterministic evaluator rejected it correctly, but discarded the observed value before the semantic repair request. The model received the assertion category and an internal target identifier without the failed predicate or its actual observation.

## Summary

The error occurred in an uncommitted development trajectory with other independent failures. Candidate preservation worked; observation rendering correctly waited for deterministic validation. Neither guardrail ensured that repair received the evidence explaining the rejection. This repair-feedback fix does not establish gameplay success or a measured reduction in model calls.

## Timeline

- The evaluator checked operations sequentially, mechanics against the source state, and events and outcomes against the resulting state.
- A transition asserted absence of an entity present in canonical truth; a subsequent repair repeated the failure.
- Ledger inspection found that the rejection message retained only target and assertion kind.
- An error carrying failed results and a shared reference projection restored those observations to the existing bounded repair loop.

## Root cause

The evaluator collected complete assertion results but reduced failures to a plain error string. The repair context could preserve the rejected candidate without recovering which observed state contradicted it. Tests checked rejection and eventual recovery, but their model fixture generated a fresh deterministic answer regardless of feedback content, hiding the missing evidence.

## Guardrails

[The transition entry test](../../src/engine/mechanics/__tests__/transition-validation.test.ts) checks that the repair sees the rejected candidate and the observed presence, placement or clock value before any observation work. [The causal evidence test](../../src/engine/mechanics/__tests__/causal-repair-evidence.test.ts) checks sequential evaluation stages, typed reference projection, source-state and expanded-proposal hashes, and absence of mutations. The repair issue uses a target handle and an explicitly expanded operation index instead of claiming a raw candidate field path after mechanical expansion. Accepted transitions and deterministic validation rules remain unchanged. Live comparisons follow the [non-thinking experiment contract](../specs/0029-nonthinking-gameplay-efficiency-experiment.md).
