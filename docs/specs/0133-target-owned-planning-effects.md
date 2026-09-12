# Target-Owned Planning Effects

Artifact-Version: 1
Status: Approved

## Intent

Reduce first-response planning failures caused by target-list and effect-position dependencies under the complete-player objective in [0122](0122-player-action-efficiency.md). Test structural ownership rather than another repair instruction.

## Contract

An explicit benchmark representation replaces a plan's targetIndices and three effect fields with an ordered targets array. Each target declares one exact existing entityRef from the complete current target domain and an effects array. Each effect entry declares its primary, secondary or threatened role and the complete original effect body without a separate subject position. The containing target explicitly selects the effect subject. Each role may occur at most once per plan. Empty effect arrays preserve targets with no receipt effect; repeated targets and their order remain representable. An absent role decodes to the canonical null effect; the existing mode and materialization rules retain responsibility for required effects.

The codec preserves every valid plan's targets, effect roles and bodies, free text, factors, causes, means, optional fields and source-slot membership. It reconstructs only relationships explicitly selected by the model. It cannot infer an entity from prose, select a target for an orphan effect, merge duplicate effect roles, or suppress a malformed neighbor. Invalid selections retain their rejected source in a canonical rejection marker while independently valid slots remain decodable. Unknown action ownership retains the original physical rejection behavior.

The input context, full action count, original target catalog, model, disabled thinking, canonical schema, downstream materialization and semantic review remain unchanged. Replace the indexed target instructions in both system and contract tail so the actual generated representation has one authoritative description. Bind all source data and schema to the adapter and reject mutation or incompatible representations. This is a generation contract experiment, not a claim that entity names guarantee correct semantics or that malformed historical plans can be repaired deterministically.

## Plan

Implement the representation through the existing physical provider chain and real gateway. Round trip complete accepted recorded plans and retain their existing semantic concerns. Reconstruct the original full49 first planning request exactly for the baseline; quantify complete request and generated representation overhead with zero HTTP. Freeze a two-call B/C feasibility screen, one response per arm on that complete source, no repair, continuation or resampling. Historical empty-target outputs remain failures and cannot be converted by inventing their targets.

## Verification

Exercise distinct and repeated targets, absent roles, all effect kinds and mode branches, role multiplicity, unknown or cross-slot entities, mixed old/new fields, malformed target records, source mutation and a valid neighboring slot through actual gateway/coordinator boundaries. Preserve original accepted canonical values and all rejection evidence. Run focused tests and check:fast before a local commit and dispatch. Report initial gateway acceptance, schema validity, source-subject alignment, full input/output tokens and transport separately. One pair cannot establish reliability or qualify complete gameplay; adoption requires source review and the original full-player criteria.

## Evidence

[Decision 0186](../decisions/0186-nest-effects-under-explicit-targets.md) owns alternatives. [Indexed planning](0044-source-indexed-planning-records.md) remains the downstream reference decoder; [repair diagnostics](0132-indexed-target-repair-diagnostics.md) remain a separate failed recovery hypothesis.
