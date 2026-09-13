# Specialize Reaction Target Domains

Artifact-Version: 1
Status: Approved

## Intent

Prevent reaction generation from choosing observations, claims or unintroduced identities as replacement-action targets. The complete-player acceptance remains in [Spec 0122](0122-player-action-efficiency.md).

## Contract

The reaction target domain contains exactly the local entities in the reacting Agent's belief and the current stimulus introductions, intersected with the resolver's local-entity target candidates. A reference merely mentioned by an apparent claim is not introduced. Generation exposes this finite domain in the targetHandles item schema. Empty and repeated selections, target ordering, keep versus replace, arbitrary action text, goal and means remain expressible. Other input evidence and canonical output fields retain their contracts.

The same domain owns runtime validation. Invalid outputs remain rejected with the precise replacementAction.targetHandles index, original reference and complete valid domain in repair feedback. No target is inferred, removed or replaced in code. The canonical draft parser and subsequent action compilation, perception, world adjudication and atomic commit remain authoritative. A versioned reaction producer binds the generation schema to the actual source domain.

## Plan

Exercise AgentMind.react with known entities, a new introduction, evidence-only references and an invalid neighbor. Compare the source failure with the source-specialized schema through the real model gateway. Preserve the complete first-attempt reaction cohort from one full 49-Agent player execution, including successful controls. Baseline requests must reconstruct their original HTTP bodies before dispatch. Alternate B/C order by source ordinal, permit one primary response per source and arm, and stop before any repair or transport retry. Freeze all request hashes and the current clean code revision before paid calls.

## Verification

The deterministic regression verifies exact legal target coverage, keep, empty and repeated targets, unchanged state and action text, rejection of canonical and observation references, introduction availability, and precise repair evidence. Run the focused tests and check:fast before committing. The source-bound screen reports request sizes, input/output/cache tokens, transport time, initial schema acceptance and target-domain acceptance separately. It preserves rejected responses and requires independent review of replacement intent. Source-level acceptance does not establish complete gameplay, a stable failure rate or the 60-second target. Full-player comparison follows with a newly frozen producer and original 48 NPCs plus one external participant.

## Evidence

The observed failure occurs after generation: a reaction repeatedly selects its delivered observation as an action target. The resolver's broad target use also includes Agent and claim references that the reaction materializer cannot accept. [AgentMind](../../src/engine/algorithms/eager-reference/agent-mind.ts) owns the exact field domain and [the regression](../../src/engine/algorithms/eager-reference/__tests__/reaction-target-domain.test.ts) exercises its real entry path. Source identities and empirical results remain in the research record.
