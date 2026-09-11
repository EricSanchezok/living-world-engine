# Indexed Transition Diagnostic

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), address repeated malformed nested transition batches while preserving every assigned action, effect and causal constraint. Reuse the existing reversible flat-array representation and bind outcome identity to source actions.

## Contract

An opt-in transition codec represents complete batch results as explicit root arrays. Every array remains mandatory, including empty arrays. Each outcome selects an actionIndex from an immutable index containing the exact original action and owning slot; the codec restores only its actionRef and slot. Other array rows explicitly retain their slot. Preserve outer slot order, per-slot row order, all variable fields, assertion types, causes, effects, statuses and prose. Require every assigned action exactly once. Reject unknown, missing or duplicate actions, extra identity fields, missing columns and invalid ownership. Never synthesize effects, repair references, choose status or count a summary as an applied write.

The full shared context and per-slot candidate scope remain present. A hash-bound source work index repeats original assigned actions for output coverage without granting access to other slots. The source snapshot, output schema and index are part of the request fingerprint. Existing canonical validation and semantic review remain authoritative. The corrected assertion-state contract from [postmortem 0075](../postmortems/0075-transition-assertion-evaluation-states.md) applies; historical failed wording and flat-output experiments remain failed.

## Plan

Implement and verify the reusable codec without changing the default Composition or game API. Freeze a diagnostic on the complete twelve-slot transition root from trajectory-e2-09, using its original full context, source actions and DeepSeek v4 Flash with thinking disabled. No action or batch reduction, model upgrade, warmup, transport retry or historical trial restart is permitted. The paid launcher freezes two fresh first-response requests on that same full root, with one HTTP per repetition, no repair, and a maximum of two HTTP. Any failed strict-JSON, canonical-schema, action-coverage or reference-membership result stops the remaining repetition. Reserve the complete trial ceiling against the existing STEP-E2 probes allocation and retain raw evidence and partial reports; unknown billing keeps its reservation. This unpaired selected-failure diagnostic has no improvement claim.

Require strict format, complete source action coverage, exact reference scope and independent source-bound semantic inspection before considering a new gameplay candidate. A passing diagnostic permits only a fresh complete-world trial with all runtime and per-commit checks. It cannot establish first-pass improvement or continuous gameplay. Keep costs, repair, token counts, actual HTTP and unknown billing distinct.

## Verification

Exercise codec round trips with compound action text, differently ordered slots, nonempty operations and events, typed assertions, and nontrivial slot ownership. Mutations of source context, missing actions, duplicate indices, foreign owners and omitted arrays must fail. Verify the actual structured-provider boundary preserves model settings, state, original schema validation and downstream preprocessors. Run focused tests and check:fast before committing each independent unit.

## Evidence

The independent STEP-E2 local evidence directory retains frozen Ledger requests and raw responses from trajectory-e2-09, including its terminal batch's missing fields and status drift. Prospective manifests bind source, request and code hashes. The [launcher](../../scripts/experiments/step-indexed-transition-probe.ts) verifies the exact historical payload hash and current request fingerprint. Repository tests establish representation invariants; paid source behavior and whole-world playability remain separate evidence requirements.
