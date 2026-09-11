# Premature Plan Batch Closure

Artifact-Version: 1

## Executive summary

Two bounded repair responses closed the physical batch before all logical slots were represented. The established parser recovered only a final standalone slot object, which correctly failed the complete batch schema. Previously admitted slots survived, but neither new call recovered the failed logical groups.

## Summary

Plans contain action identities as well as a second layer of slot identities and nested result wrappers. The request already determines the slot for each action. Requiring the model to repeat that structure creates a failure surface independent of action semantics.

## Timeline

- A first-call factor representation probe left four logical groups unadmitted.
- A separately frozen recovery probe replayed the exact initial response and retained its accepted actions.
- Both new repair responses closed the outer batch early and emitted additional slot objects outside it.
- Strict parsing rejected the extra top-level content; the existing correction policy returned a standalone final slot instead of a batch.
- An opt-in flat output contract assigned wrapper construction to the frozen input binding.

## Root cause

The [batch coordinator](../../src/engine/mechanics/truth-batch-provider.ts) requests redundant nested routing structures. The [parser](../../src/engine/models/model-adapter.ts) cannot safely infer intended grouping from misplaced delimiters. Schema rejection is correct; guessing a reconstructed grouping would hide an unresolved ownership decision. Other invalid references in the same responses remain separate failures.

## Guardrails

[Spec 0040](../specs/0040-flat-resolution-plan-batches.md) restricts wrapper derivation to explicit uniquely assigned actions in new responses. Canonical round-trip, ownership and batch-isolation tests guard the decoder. Unknown or incomplete ownership must fail without guessing. The experiment does not change parsing or certify semantics; prospective complete-source comparisons and behavior review remain required.
