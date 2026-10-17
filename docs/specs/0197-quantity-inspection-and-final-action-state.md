# Quantity inspection and final action state

Artifact-Version: 1
Status: Approved

## Intent

Complete the real-resource and actual-action verification authorized by the user's Fanren implementation plan and [Spec 0196](0196-canonical-world-and-participation-seeds.md). A local stock inspection must be able to reveal its real quantity without publishing unrelated holdings. A completed physical method must leave its final state, and an authorized inspection followed by a report must retain that continuation.

## Contract

- The world adjudicator decides whether each quantity held by the selected inspection target is actually measurable through the attempted channel. Mere presence, an entity name, a hidden account or a sealed container does not establish its count.
- Admitted quantity identities are saved with the prepared action. Mechanical settlement reads their current values, preserving the existing dependency, conflict, failure and replay boundaries. No duplicate canonical inventory fact is created.
- Only the inspecting actor receives that quantitative observation. Another actor learns it through their own inspection or delivered speech, not merely by watching the inspector.
- Missing and hidden quantities remain unknown. An absent resource row is not evidence of a measured zero. An explicit visible zero row can be reported as zero.
- Physical effects represent the end of the selected method. Temporary intermediate manipulation does not become a continuing condition after it has ended. Owned costs still apply when a performed method returns its target to its original state.
- Evidence that the selected observation can obtain is not an external waiting dependency. A distinct authorized report continues after observation; inability to obtain an exact count permits a truthful uncertainty report, not an invented number.
- This is generic runtime behavior. No novel-specific predicate, number, action or character is part of the engine.

## Plan

Add bounded target quantity judgments to the existing world batch, persist admitted references, project actor-only observations at settlement, and advance the direct producer identity. Clarify final-state and continuation semantics. Verify through the real simulation entry and repeat the recorded live actions.

## Verification

Exercise visible, hidden and zero quantities, nearby but uninspected stocks, witness isolation, unchanged inventory, canonical replay, actor costs with no lasting qualitative effect, and later reporting through delivered speech. Preserve failed live evidence and report actual semantic outcomes rather than successful revision alone. Run focused tests and the repository fast gate.

## Evidence

The recorded sample identifies the initial failures in [the follow-up runs](../../worlds/fanren/authoring/validation/followup-live-runs.json). Its final qualification remains separate from the implementation contract.
