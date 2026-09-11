# Source-Bound Plan Choice Schema

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), expose exact existing action and target choice domains in the planning output schema. Pattern-only selector schemas allow syntactically plausible choices absent from the actual request.

## Contract

An opt-in physical request wrapper derives action choices only from assigned actions, and target selector choices only from target-eligible entity records in the complete reconstructed request contexts. It preserves every source record, canonical schema, output value, generation setting and existing decoder. Shared contexts are hash-verified before binding. Unknown or ambiguous inventories fail preparation.

The wire schema uses shared JSON Schema definitions to enumerate the full root's assigned action references and the union of its target selectors. This union does not grant cross-slot permissions: existing per-slot selector decoding and canonical validation still enforce exact ownership. Means sources, factors, effects, quantities and open action semantics remain unchanged. No native provider schema enforcement is assumed; the schema is model-visible guidance with deterministic validation still authoritative.

The wrapper is independently opt-in and versioned by its exact instruction, schema and domains. It composes below flat plan grouping and source selectors without changing repair evidence. It applies to physical planning batches and their existing singleton repair path. Unknown outputs are rejected by existing checks rather than mapped to nearby choices or discarded. A repeated wrapper or incomplete source binding fails explicitly.

## Plan

Verify source preservation, complete domain coverage, shared and singleton repair bindings, JSON Schema reference resolution and existing canonical decoder composition. Freeze a new prospective qualification only after implementation checks. Keep historical failed trials immutable.

## Verification

Exercise real admission with an invalid target selector beside a valid neighbor, showing the original rejection and targeted repair despite the more precise wire schema. Check that foreign action and target choices fail wire validation, all legitimate choices remain representable, and no model-visible facts or batch cardinality are removed. Run relevant tests and check:fast before committing. Qualification gates own their fixed samples, call limits, costs and claim limits; formal admission alone does not establish semantics or gameplay.

## Evidence

[Decision 0131](../decisions/0131-bind-plan-choice-domains.md) owns the alternatives. Frozen local source probes retain raw over-coverage and invalid-selector evidence; [0040](0040-flat-resolution-plan-batches.md) owns flat grouping.
