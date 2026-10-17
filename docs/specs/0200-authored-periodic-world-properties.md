# Authored periodic world properties

Artifact-Version: 1
Status: Approved

## Intent

Replace permanently frozen environmental time descriptions with deterministic authored cycles. The user's 2026-10-17 instruction to finish the approved world, repair real-play failures and validate natural long-term play authorizes this implementation within [0196](0196-canonical-world-and-participation-seeds.md). This contract supports recurring physical properties such as daylight; it does not schedule novel events, make NPC decisions or award cultivation progress.

## Contract

- A world may define periodic properties with a stable identity, one subject, predicate, access policy, period in positive integer seconds, initial phase and ordered phase values with descriptions. Phase starts begin at zero, strictly increase and remain below the period. Values use the ordinary fact-value contract. Entity references and identity collisions are validated before import.
- Each property owns a single canonical fact. Its value is derived from the world's elapsed seconds and the authored phase offset. The loader establishes the initial value; advancing world time updates it deterministically in the same atomic transaction. Ordinary semantic effects cannot overwrite or remove that owned fact. The phase definition remains immutable for the world version.
- Phase boundaries are meaningful clock boundaries. Execution cannot skip an earlier boundary, including during a long activity; crossing a boundary alone does not require an extra model call, force an NPC action, or grant anyone information. Existing state-dependent action validation still applies.
- Observation uses the property's value at the actual observation boundary, after elapsed time and admitted actions. Past observations and beliefs remain evidence of their original time and are not rewritten. The ordinary authored access policy and local perceptual checks determine who learns a changed property. Knowing an astronomical rule does not grant sight through walls or access to distant locations.
- The adjudicator receives current elapsed seconds and the relevant cycle definitions and next transitions. Clock arithmetic is deterministic, while interpretation of a proposed action remains semantic. Cycles do not automatically open a closed shop, make a worker start a shift, create speech or interrupt an activity without the ordinary causally admitted perceptual event.
- A world can give different locations different cycles. Daylight periods are independent of elapsed-duration terms and age/year conventions; the author must make their intended relationship explicit. Empty cycle catalogs preserve ordinary worlds. This is a forward-only schema change coordinated with [0199](0199-long-activity-duration-and-interruption.md), without world-specific engine branches or save migration.

## Plan

Add a validated authoring schema and deterministic mechanics helper. Materialize owned facts during loading and time advancement; integrate the next phase boundary and actual-time observation values with the direct runtime. Wire the world's local daylight definitions and initial perceptual knowledge, then validate ordinary host play.

## Verification

Exercise real import and simulation paths for human-length and longer cycles, exact phase boundaries, wraparound and multi-day progression. Check incompatible definitions, missing subjects, identity collisions, immutable owned facts, transactional rollback, clock overflow and replay. Verify a local observer receives the new value while a distant or inaccessible subject does not; an old observation remains unchanged. Test simultaneous action effects and a clock boundary, and show no extra semantic call is needed merely to advance an unobserved phase. Actual long-rest tests must use durations that cross the authored local transition rather than assuming all realms share a day length.

## Evidence

Real-play inspection found a static night fact used after long elapsed intervals, without a time-derived replacement. [Direct settlement](../../src/engine/direct/settlement.ts) and [transaction application](../../src/engine/runtime/transaction.ts) are the ordinary boundary paths to qualify. The existing sample's eight-hour Spirit Realm rest is not itself proof that daylight should have begun; the authored realm period determines that expectation.
