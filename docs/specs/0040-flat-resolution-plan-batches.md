# Flat Resolution Plan Batch Experiment

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), remove redundant model-generated slot wrappers from physical planning batches. A plan already identifies its original action, whose logical slot is fixed by the request. Preserve the full input and all canonical validation.

## Contract

An opt-in physical codec requests one commit_plans object containing all plans assigned across the current physical batch. Each assigned actionRef must occur exactly once. The decoder groups plans by the unique action-to-slot binding derived from complete reconstructed input contexts. It preserves each plan's fields and per-slot relative order, creates only the canonical slot/result wrappers, and passes them through the existing representation decoders, schema, references, materializer and semantic review. A valid canonical batch round trips exactly, including its outer slot order. Arbitrary interleaving in a new flat response preserves per-slot plan order; cross-slot interleaving has no causal authority.

Unknown, missing, duplicate or cross-root action references fail the physical response rather than being guessed, discarded or assigned to an arbitrary slot. Their missing ownership can prevent partial slot salvage, an explicit experimental tradeoff. Independently malformed plan fields with known ownership retain normal per-slot rejection and recovery. Extra root fields, canonical-wrapper bypasses and incomplete slot bindings fail. Logical singleton requests, non-planning roles and runtime defaults remain unchanged.

Original contexts, candidates, natural-language actions, slot responsibilities, model settings, parser policy, repair limits and physical batch cardinality stay intact. Existing candidate and error evidence retains its canonical slot coordinates; the output instruction explains that feedback shape separately from the requested flat response. No parser guesses or historical response reconstruction are introduced.

## Plan

Implement source-bound regrouping and the exact wire-schema transformation below existing physical codecs. Verify complete canonical round trips, independently reordered slots, interleaved flat plans, invalid ownership, isolated malformed plans and shared-context bindings. Capture full original roots offline, prove unchanged source context, then freeze a separate paired non-thinking trial.

## Verification

Exercise the real batch coordinator and admission path with all assigned actions, source selectors and factor types. Verify no new calls or logical splits, retain valid neighboring slots, and preserve candidate/error ownership through repair. Invalid ownership must fail before partial results can be accepted. Run relevant tests and check:fast before each commit. Mechanical admission alone does not certify open semantics, general reliability or gameplay.

## Evidence

[Decision 0130](../decisions/0130-derive-plan-slot-wrappers.md) owns the alternatives. Local frozen trial records retain original raw responses, parser failures, request/source hashes and measured costs.
