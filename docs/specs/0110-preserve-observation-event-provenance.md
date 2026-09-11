# Preserve observation event provenance

Artifact-Version: 1
Status: Approved

## Intent

Repair observation preparation failures under the delegated [gameplay optimization](0029-nonthinking-gameplay-efficiency-experiment.md). A realized event can cite a real fact outside the assigned observer's authorized fact view. Its causal identity must remain projectable without granting knowledge of that fact.

## Contract

The observation reference resolver retains existing candidates cited by the current proposal's event causes. The source is the same immutable candidate/proposal snapshot used for initial observation and scoped repair. Event descriptions, identities, cause order and multiplicity remain unchanged. Only candidates already in the broad resolver can survive narrowing; a nonexistent source does not acquire a candidate through this rule.

Canonical fact values and observer-private facts retain their existing access filters. A causal reference is provenance, not permission to perceive its target or disclose its contents. Unrelated hidden candidates remain excluded. Existing information-boundary validation, observer-local identities, source validation, model recovery and atomic commits retain their authority. No event is dropped, paraphrased or made public by this repair, and no model call or inference effort is added.

## Plan

Close the reference domain over the events actually supplied to the observation task, rather than the intentionally empty historical-event projection. Bind both registered observation implementations to a new version. Preserve failed trial evidence and measure a new player run after local verification; context construction success alone is not a gameplay or semantic acceptance result.

## Verification

Use the real loader and ObservationRenderer entry with an event citing a private fact, an agent-scoped fact viewed by its owner and another observer, and a nonexistent fact. Verify exact event causes, unchanged source input, authorized fact values, excluded unrelated private candidates and rejection before dispatch for missing sources. Have a controlled model disclose the hidden fact, confirm the existing boundary rejects it, and verify scoped repair retains the same provenance. Run relevant tests and check:fast before committing.

## Evidence

[Observation regressions](../../src/engine/cognition/__tests__/observation-renderer.test.ts) own the context and repair assertions. [Postmortem 0111](../postmortems/0111-observation-provenance-outside-fact-view.md) records the escaped domain mismatch. The [observer-owned layout](0092-observer-owned-outcome-layout.md) preserves the surrounding complete task.
