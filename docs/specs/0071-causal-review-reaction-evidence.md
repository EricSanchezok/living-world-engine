# Causal Review Reaction Evidence

Artifact-Version: 1
Status: Approved

## Intent

Expose actual Agent reaction decisions to the existing causal reviewer under the [non-thinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md). The component resolution path closes reaction routing before review; an empty component-local reaction list must not hide decisions already made during step preparation.

## Contract

The complete step reaction decision set reaches every component's causal review, including global fallback and review retries. This is additive context: existing state, actions, candidates, effects, observations, rules and output responsibilities remain present. Decisions retain their source, actor, revision, keep disposition or replacement action. A source hash and ordinal bind projected records to the full supplied decision set. Unavailable evidence is explicitly different from a supplied empty set. Unavailable original-action handles remain null rather than being invented.

The reviewer distinguishes intention, conditional plans, actual Agent choices and realized effects. A keep decision is not a newly authored reply, acceptance or promise. A plan is not independent evidence that its goal occurred; identity and placement assertions support only their predicates. Legitimate continuing, waiting, blocked and already-satisfied actions may have no physical delta. This clarification does not prescribe action meaning or automatically reject every no-effect candidate.

No online model call is added, no generation parameter changes, and no input is truncated. This unit does not certify reviewer accuracy or solve post-review global observation replacement. Both require separate verification before gameplay acceptance.

## Plan

Reproduce the missing evidence through the real step entry path, pass completed preparation decisions through component resolution, and project them into the causal reviewer. Run focused regressions and check:fast before committing. No paid trial is authorized by this implementation unit alone.

## Verification

Exercise actual keep and replacement reactions through SimulationEngine and inspect the request received by the existing causal reviewer. Verify supplied-empty versus unavailable evidence, source hash changes, preserved original context, null unavailable references and retained replacement content. Preserve existing state, replay and model-call behavior tests.

## Evidence

[Step regressions](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) own preparation-to-review delivery. [Context regressions](../../src/engine/contracts/__tests__/activity-temporal-evidence.test.ts) own evidence projection and unchanged surrounding context.
