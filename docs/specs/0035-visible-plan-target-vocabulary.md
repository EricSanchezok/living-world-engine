# Visible Plan Target Vocabulary Experiment

Artifact-Version: 1
Status: Approved

## Intent

Under [0029](0029-nonthinking-gameplay-efficiency-experiment.md), test whether enumerating already selectable entity handles in the physical plan output schema reduces invented target references. Natural-language actions, model settings and thinking-disabled execution remain fixed.

## Contract

The opt-in adapter runs below physical batching and after any dependent-fields encoding. It changes only the wire schema for plan `targetRefs` and the prompt identity that binds that schema. Each allowed value comes from an entity candidate whose catalog allows target use in at least one current slot. Shared contexts are expanded with their existing hash checks before collecting the sorted union. The union preserves every slot's legal choice; it does not authorize a handle in a different slot. Existing per-slot reference resolution, task scope and semantic validation remain authoritative.

No state facts, action text, context values, candidate membership, output values or canonical schema are modified. No entity is created, guessed or substituted. A request with no available entity permits the existing empty target list only. Other reference fields, roles and plan control directives retain their contracts. Schema enumeration is model-visible guidance on the hosted JSON interface, not a claim of native constrained decoding or guaranteed adherence. No registered runtime default changes in this experiment.

## Plan

Bind a bounded source probe to the complete failed Truth request and snapshot. Keep the complete physical batch and generation settings, report input/schema overhead, actual HTTP, cache hits, latency, raw output, repairs and terminal validation separately. Preserve historical runs and charge all new requests to the existing E2 journal. Any candidate promotion needs a separate frozen Composition and source review before fresh full-world execution.

## Verification

Exercise the actual Truth coordinator/provider boundary: equal logical requests still form one complete physical batch; dependent-field decoding and canonical validation remain intact. Verify singleton and shared codecs, all legal target choices, empty domains, exclusion of other kinds/uses, corrupted snapshot rejection and immutable source values. An invented handle remains rejected, and the adapter never rewrites an output into a valid entity. Run relevant tests and check:fast before committing.

## Evidence

[Decision 0125](../decisions/0125-enumerate-visible-plan-targets-after-batching.md) owns the tradeoff. The experiment evidence index owns the source invocation, raw response, protocol hashes and measured results. The active failure is an invented entity target after plan repair exhaustion; other observed structural and assertion errors remain distinct failure classes.
