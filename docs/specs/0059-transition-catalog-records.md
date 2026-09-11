# Transition Catalog Records

Artifact-Version: 1
Status: Approved

## Intent

Within the delegated [non-thinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md), reduce repeated candidate-policy input without removing context or references. [Decision 0138](../decisions/0138-factor-shared-catalog-records.md) owns the representation tradeoff. This is a lossless input intervention, not a semantic certification method.

## Contract

The worklist context may encode the shared catalog as shared-json-v3-catalog-v1. Its shared.referenceCatalog.candidates contains templates and rows. A row is indexed by its unchanged original catalog key and contains a template index plus an object of original handle, label and statePath fields that were present. Templates retain every other original field. No absent field is supplied, no handle is renamed, and unknown future record fields remain in templates unchanged. Empty records and partial shared records remain representable. With no shared candidate map, the prefix representation is unchanged.

Expand records before combining shared state with original slot deltas. The existing prefix and per-slot suffix still restore every ordered candidate domain. Validate every original logical source hash and canonical template encoding; reject missing, altered, foreign, duplicated or unused records/templates rather than fixing them. Input record-map key order is nonsemantic; original catalog candidate order remains explicit and unchanged. Output fields, references, permission checks, assertions and effect semantics are unchanged.

Keep the full world, original twelve logical slots and forty-three actions, model, disabled thinking, generation settings, recovery bound and append-only budget. The complete original source remains available through reconstruction. No model call performs reconstruction or selects a reduced domain. The same-source semantic failure remains failed even when its input representation becomes smaller.

## Plan

Verify the representation and measure complete-request tokens offline before authorizing a fresh paid diagnostic. Freeze any diagnostic separately after checks and commit, with the existing two-HTTP ceiling. Compare actual first-pass coverage, semantic failures, tokens, latency and costs; do not attribute all outcomes to input length or claim smaller-model generality. A complete game test retains its existing causal verification, repair, replay and source-bound acceptance checks.

## Verification

Exercise exact round trips for shared and per-slot fields, distinct candidate permissions, absent fields, null values, record-map order, empty maps and catalogs without shared candidates. Reject row/template corruption, slot membership or rank changes and noncanonical encodings. Test the actual worklist request and output gateway, complete original source reconstruction and real HTTP-body token admission. Run check:fast before committing.

## Evidence

[Shared record tests](../../src/engine/mechanics/__tests__/shared-catalog-records.test.ts) bind templates to original logical contexts. [Worklist gateway tests](../../src/engine/mechanics/__tests__/transition-evidence-worklist.test.ts) retain complete source recovery and canonical output validation. Independent local evidence records token measurements, frozen diagnostic identities, semantic reviews and budget effects.
