# Fixed Planning Candidate Selection

Artifact-Version: 1
Status: Approved

## Intent

Test whether a model can select a supported whole planning proposal from a frozen pool before paying for prospective proposal sampling in the [complete-player experiment](0122-player-action-efficiency.md).

## Contract

The benchmark binds three raw proposals to one complete initial singleton planning request and its actual world, actions and groundings. It preserves the entire source context and original planning instructions as reference data. Human semantic labels and historical review conclusions are excluded from the selector request. Canonical projection, complete initial and available actions, assigned action identity and the original request remain bound throughout selection.

Each raw proposal passes through the original request decoder and schema, followed by the runtime's read-only plan materializer. This fixed screen admits automatic plans only, before any check, random or plan commitment. Other plan modes are outside this diagnostic's scope; no registered runtime policy or legal player action is restricted. Eligibility means admission within this scope, not semantic correctness or completed resolution.

The selector returns exactly one eligible candidate index or an explicit abstention, plus a reason. It cannot edit, combine, repair or supply a plan. The selected raw proposal remains unchanged, including randomness declarations, explanations, evidence, quantities and all other fields. The original execution pipeline revalidates it before the semantic verifier boundary. Selection never commits state or consumes world randomness. No eligible candidates, malformed selection, rejected selection or source/request drift fails closed. Abstention remains an unsuccessful diagnostic, not a gameplay completion.

## Plan

Add a benchmark selector with source binding, decoder and materializer screening, and a strict selection-only prompt. Exercise it through TruthEngine and the real model gateway with controlled HTTP. Freeze the checked producer, complete pool, exact physical body and one-call ceiling before a paid selection. Preserve every response, token usage, latency, failure and semantic review independently of mechanical admission.

## Verification

Verify whole-candidate identity, unchanged full context, original representation decoding, own-action and means-source rejection, no mutation or RNG, explicit abstention, invalid indices and edited output, unsupported modes, empty eligibility and stale source/request handling. The prospective fixed-pool run permits at most one HTTP and no retry, repair or replacement. A supported choice establishes only this diagnostic result; reliable fresh sampling, its total cost and the full-player objective require separate evidence. Run check:fast before the local producer commit.

## Evidence

[Decision 0219](../decisions/0219-screen-fixed-planning-candidate-selection.md) owns the alternatives. [Selector tests](../../src/engine/benchmarks/step-efficiency/__tests__/planning-candidate-selection.test.ts) exercise the executable boundary.
