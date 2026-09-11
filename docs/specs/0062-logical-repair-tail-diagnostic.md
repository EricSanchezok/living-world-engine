# Logical Repair Tail Diagnostic

Artifact-Version: 1
Status: Approved

## Intent

Within the user-delegated [gameplay optimization](0029-nonthinking-gameplay-efficiency-experiment.md), test whether placing exact logical repair evidence after the schema improves complete recovery. The layout hypothesis follows [Lost in the Middle](https://arxiv.org/abs/2307.03172); that research does not establish an effect for this model or task.

## Contract

An explicitly selected `logical-tail-v1` layout relocates the complete logical repair object and its existing uncommitted-data instruction from the serialized context to the request tail. All other instructions, schema, state, source actions, candidate data and binding hashes remain exact. The durable context contains the original complete envelope. A physical repair object, absent logical binding or missing/duplicate candidate instruction is rejected rather than guessed. Default rendering and physical repair placement remain unchanged. No gameplay provider selects the experimental layout automatically.

The paired diagnostic uses the same frozen twenty-four-action repair source as [0061](0061-transition-example-diagnostic.md), with the illustrative example omitted in both arms. B retains inline feedback; T relocates it. Both arms make one new independent HTTP request with disabled thinking, no automatic retry and no output transfer. A complete pair must fit the current phase and total budgets. Unknown billing, inference drift or interruption stops new dispatch; formal rejection is reported without declaring a semantic pass.

## Plan

Extend the existing explicit placement contract through request sizing, gateway audit and JSON transport. Verify reconstruction of the original context and unchanged source/schema before a prospectively frozen pair. Keep previous negative examples and repair trials closed. Runtime selection, source-semantic acceptance and gameplay confirmation remain separate decisions.

## Verification

Test exact source reconstruction, malformed feedback rejection, unchanged default/physical layout, schema-before-feedback placement and full audit retention through the actual gateway. Offline preparation checks that B exactly matches the prior no-example body and T changes only the declared placement. Run relevant tests and check:fast before committing.

## Evidence

[Repair layout tests](../../src/engine/prompts/repair-layout.test.ts) own reconstruction and misuse rejection. [Gateway tests](../../src/engine/models/__tests__/model-provider.test.ts) own actual transport and audit. [Logical candidate binding](0037-truth-rejected-candidate-repair.md) remains authoritative for candidate identity and lifetime.
