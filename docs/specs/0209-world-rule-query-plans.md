# World rule query plans and shared perception premises

Artifact-Version: 1
Status: Approved

## Intent

Implement the user's approval to start the rule-query-plan and shared-perception phase, then compare real turns against the frozen producer. Preserve game quality, world consistency, cognitive isolation and open actions. A complete validated turn within sixty seconds is the performance target, not permission to omit work or relax validation.

## Contract

- Compile the existing world questions before the existing single decision dispatch. Retain complete world rules, authorized state, dependencies, finite candidates and open qualitative expansion. Unknown applicability remains an explicit result. No keyword filter, top-k truncation, extra planning model or model downgrade is introduced.
- A resource rule's applicability and its conditional amount form one sum-type query: not applicable, unresolved, or applicable with an existing amount (including no change). The amount of an inactive rule remains inert. Restore logical answers before the existing effect materializer; quantities, sources and conservation retain their current owners.
- Delivery and actor visibility for one action and one recipient form a product-type query over every original pair of answers. Share their bound event and physical premises without conflating hearing, sight, identity, willingness, private facts or relevance. Different recipients and discovery conditions do not merge.
- The compiler only accepts explicit owner-supplied groups. Reject overlapping, missing or incompatible groups before dispatch. If a complete fused domain exceeds the provider contract's finite-choice limit, preserve the original questions in that same batch. Never drop candidates or introduce another dispatch to fit it.
- Preserve a deterministic source-to-dispatch mapping and its version in the evidence. The decision cache binds the complete logical source and plan. Actual request/response audits retain physical query IDs; logical results retain the original question IDs. Derived answers do not pretend to carry independently sampled provider confidence.
- Pin the producing algorithm version. Replay reconstructs the same plan and uses recorded physical answers with no network. No migration or producer substitution occurs in the user's current save.
- Qualification reports complete wall time, first validated feedback, physical calls, input/cache/output/reasoning usage, initial rejection, repair recovery and terminal failure. Preserve failed and timed-out samples. Compare actual facts, delivered observations, timing, knowledge boundaries and open actions, not merely schema validity.

## Plan

Add a pure query compiler at the direct world's decision boundary, integrate its explicit resource/perception groups, cover semantic equivalence and real simulation/replay entry paths, and run a bounded real-turn comparison from an isolated data root. Keep the current playable checkout until the candidate's quality evidence is reviewed. Broader rule applicability declarations and persistent subquery reuse are separate work; no unproven rule exclusion is inferred in this phase.

## Verification

Exhaustively cover all perception answer pairs and resource branches, including unknown and applicable-zero. Prove complete logical restoration, unchanged source state, dependencies and candidate coverage, invalid-group rejection, full-domain overflow retention, physical dispatch count and malformed-answer failure. Run real entry tests for hidden sight with audible speech, no delivery, private/discoverable evidence, resource consumption, shortage rollback, unknown/open effects and recorded replay. Run check:fast before each implementation commit. A real model comparison must retain the source producer and world/model fingerprints and a bounded shared dispatch budget.

## Evidence

The [query compiler tests](../../src/engine/direct/__tests__/query-plan.test.ts) cover complete domains and invalid ownership. The [runtime tests](../../src/engine/direct/__tests__/runtime.test.ts) exercise actual perception, quantity materialization and replay. The [real-turn harness](../../scripts/experiments/world-query-plan-trial.ts) runs each frozen producer from a fresh full-world instance using one shared cumulative paid-budget ledger. Qualification results are recorded after both arms finish; deterministic tests alone do not qualify model behavior or establish speed gains.
