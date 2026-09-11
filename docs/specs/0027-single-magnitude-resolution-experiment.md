# Single-Magnitude Resolution Experiment

Artifact-Version: 1
Status: Approved

The user explicitly asks to continue optimization on 2026-09-07 after the original ten-hour window. This continuation uses the remaining independent CNY 1000 budget and its existing phase ceilings; it grants no additional money. Historical protocols, failed gates, reports and ledger entries remain immutable. The STEP-E1 record owns prospective run identities, stop rules and results.

## Intent

Remove a proven representational redundancy from resolution output without changing the action language, semantic choices, canonical plan, validators, batch membership or random commitments. The motivating rejected plan has inconsistent `baseEffect` and `primaryEffect.magnitude`; valid plans already require these fields to agree.

## Contract

An explicitly selected candidate Composition represents the base magnitude only in `primaryEffect.magnitude`. Its wire schema omits `baseEffect`; the decoder copies the primary magnitude, or restores `none` when the primary effect is null. The encoder accepts only canonical values with this equality, so it cannot silently repair an inconsistent historical output. Decoding rejects a wire plan that supplies the removed field. Missing or invalid primary effects, modes, sources, actions and other fields still fail the original canonical schema or semantic validators. No other field is rewritten.

The transformation occurs after existing physical batching and before the model adapter. It covers direct, batch and repair plan requests, preserving complete contexts, slot numbers and all current batch compatibility rules. Continuation requests, verifiers, transitions and other roles remain unchanged. Requests retain raw wire evidence, canonical output validation and a content-addressed prompt/codec identity. The deterministic expansion is not classified as a symbol repair or a model repair. Input state and previous evidence remain canonical data.

The reference algorithm and immutable instances retain their current Composition. The candidate is registered separately for experimental selection; it is not a second default settlement implementation. All final plan, reference, effect, time, knowledge and atomic commit checks remain authoritative.

The old STEP-E1 deadline is not edited. New prospective runs cite this renewed authorization and a separate continuation manifest, while using the same append-only budget journal and price bindings. All unknown reservations remain charged against exposure. No new paid run starts until its exact inputs, conditions, scoring, repetition count and stopping rule are recorded. A failed previous feedback candidate is not retried under this label.

## Plan

1. Verify round trips over consistent canonical plans and rejection of contradictory or malformed values.
2. Verify real adapter/gateway decoding, physical batch cardinality, and complete SimulationEngine state/replay behavior with a deterministic model boundary.
3. Freeze an independent paired model comparison and assess actual schema, coverage and semantic boundaries, usage and latency.
4. Admit a fresh complete-world trajectory only with sufficient local evidence and budget; require the original three consecutive commits and fresh confirmation for gameplay acceptance.

## Verification

Cover all effect bands, meter and condition effects, null effects, blocked/check modes, duplicate field injection, missing/invalid magnitude, unchanged input and action scope, batch slot isolation and unchanged HTTP count. Validate exact canonical round trips rather than decoder self-report. Run relevant tests and `npm run check:fast` before a local commit. Paid evidence cannot certify unconstrained open semantics.

## Evidence

[STEP-E1](0026-full-step-efficiency-experiment.md) defines the existing ledger and gameplay acceptance. [Decision 0112](../decisions/0112-single-magnitude-resolution-wire.md) defines the representation choice. The Notion record preserves the motivating trajectory 11 and all failed experiments.
