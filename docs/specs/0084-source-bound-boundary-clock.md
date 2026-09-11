# Source-bound outcome boundary clock

Artifact-Version: 1
Status: Approved

## Intent

Remove repeated generation of an already supplied final clock witness while retaining action semantics and strict causal validation. A continuing Activity may have reached its next checkpoint; continued status does not imply elapsed time is less than that checkpoint.

## Contract

An explicit experimental Truth configuration changes only outcome assertion representation. Every wire outcome must select boundaryClock: true. The decoder binds that selection to the same source action's complete transition worklist and emits elapsed_seconds_compare eq temporalBoundary.toElapsedSeconds. It verifies an integral positive boundary with fromElapsedSeconds plus deltaSeconds equal to toElapsedSeconds and unambiguous source identity. A missing or conflicting selection is invalid, not repaired.

For indexed outcomes this replaces firstAssertion; additionalAssertions remains model authored. Canonical outcomes retain assertions as an additional list that may be empty. All other causal assertion variants remain available in those lists. Existing generated assertions are never corrected, removed or weakened: an additional false comparison still fails. Event, operation and mechanic assertions are unchanged, including their distinct evaluation phases.

The clock witness is new explicitly selected evidence derived from trusted request data. It is neither lossless recovery of arbitrary prior assertions nor an automatic statement that the candidate is correct. It asserts no success, completion, action effect, resource transfer or knowledge. Original status, events, operations and action text remain unchanged. The causal evaluator must test the decoded clock against the actual working state after all operations and the engine's final time advance; drift still rejects the candidate.

The contract is separately pinned in the experimental Composition. The default and closed experiments remain unchanged. No additional model call, stronger inference, context truncation or batch reduction is introduced.

## Plan

Implement the source-bound wire adapter, exercise canonical and indexed decoding and actual state validation, then freeze a complete historical-input diagnostic. Combine with the event-sourced outcome candidate only as an explicitly declared experiment. Game trajectories and independent confirmation remain required.

## Verification

Check source clock and identity drift, missing/false/conflicting selection, exact preservation of additional assertions and non-outcome fields, canonical and indexed codec composition, and physical repair placement. Use the real loaded-world simulation and causal evaluator to verify arrival, continuing behavior and rejection of a false additional clock witness. Run check:fast and commit before freezing paid requests. Report source witness counts, original assertions, rejection, repair, tokens, HTTP and costs separately.

## Evidence

The [adapter](../../src/engine/mechanics/boundary-clock-witness.ts) owns clock selection; [tests](../../src/engine/mechanics/__tests__/boundary-clock-witness.test.ts) exercise canonical and indexed behavior. The [decision](../decisions/0147-reference-the-trusted-boundary-clock.md) records alternatives. The [causal evaluator](../../src/engine/mechanics/causality.ts) remains authoritative for actual truth.
