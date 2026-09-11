# Observer-owned outcome layout

Artifact-Version: 1
Status: Approved

## Intent

Associate each physical observation slot with its complete owned attempts and their reported outcomes. An observer identity alone does not distinguish another actor's action or the observer's intention from a realized occurrence.

## Contract

The observation-only slot binding copies every assigned action owned by its observer and all outcome records whose actionRef exactly matches that action. Preserve every field, list order, multiplicity and value; do not infer a status, choose a meaning, repair a reference or paraphrase text. Empty or multiple matching outcomes remain visible as supplied evidence, not synthesized success. The binding includes the exact count of the reconstructed slot's current events, without asserting that the observer perceived them.

The complete original context, including other actors, outcomes, current events, facts, reference domains and repair evidence, remains unchanged and reconstructible. The added table is an attention aid, not an exhaustive perceptual filter or an authorization grant. A continuing outcome does not exclude a supported partial event; an event count does not prove occurrence, participation, access or absence of a particular fact. The observation system contract continues to govern semantic evidence types.

Apply the same deterministic binding to initial and scoped repair batches. Direct single-observer requests retain their complete existing context. Missing structural evidence fails before dispatch; it is not silently interpreted as an empty event list. Output schemas, candidate materialization, final review and bounded repair remain unchanged. No additional model call, thinking, action reduction or hard context truncation is introduced.

## Plan

Extend the existing observation slot binding, bind its interpretation through the registered observation prompt version, and verify exact source preservation through the production batch coordinator. Measure full request changes and replay source failures and controlled events before a new gameplay experiment.

## Verification

Exercise multiple observers, foreign action owners, continuing and realized outcome records, absent owned actions, complete action fields, reordered records and scoped repairs through the real coordinator. Confirm unchanged reconstructed contexts, exact reference joins and no cross-slot transfer. Run relevant observation and batching tests plus check:fast. Paid diagnostics report formal validation using the production schema separately from source-semantic review; neither an offline layout proof nor a correct event count certifies narrative entailment.

## Evidence

The [batch coordinator](../../src/engine/mechanics/truth-batch-provider.ts) and its [tests](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) own the deterministic join. The [observation prompt](../../src/engine/prompts/system/observation-renderer.md) owns its interpretation. [Postmortem 0102](../postmortems/0102-observation-intents-reported-as-results.md) describes the failed evidence boundary; [spec 0028](0028-resolution-source-inventory-experiment.md) defines the existing observer identity table.
