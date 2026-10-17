# Action-bound discovery of latent world facts

Artifact-Version: 1
Status: Implemented

## Intent

Complete the user's approved [canonical-world contract](0192-canonical-world-and-participation-seeds.md): testing a previously unknown aptitude reveals its pre-existing state. The same mechanism supports inspecting concealed physical properties in other worlds. This implements the explicitly requested detection behavior; it does not grant access to another Agent's private cognition.

## Contract

- An authored fact can use `access: { kind: discoverable, condition: ... }`. The condition states the physical or procedural evidence needed to discover that fact. It is not initially visible in an Agent's perspective, capability-generation context, or ordinary client view.
- The trusted world adjudicator evaluates the actual action, tools, capabilities, location, outcome and authored condition. It selects the existing fact's visibility; it does not generate a replacement answer or redraw the property.
- Only the actor completing an admitted successful or partial discovery receives that fact in observation and retained belief. Bystanders, the tested subject and other Agents do not inherit the detector's findings. Speech or a separate observation can convey information through its own channel.
- Discovery preserves canonical value, access policy and identity. Later changes in truth do not silently update the observer's retained belief. The observer must obtain new evidence.
- Public facts retain ordinary perceptual treatment. `private` and other Agents' restricted facts remain inaccessible even if a model mistakenly marks them visible. A failed action cannot disclose a discoverable fact.
- The addition is script-driven and contains no cultivation, character or book-specific engine branch. Existing accepted fact forms remain valid. The changed direct-world producer receives a new identity; saved executions are not migrated.

## Plan

Extend fact access validation and model transport, qualify discovery in world adjudication, retain actor-local evidence in direct perception, and author appropriate conditions for the sample's innate aptitude facts. Preserve deterministic replay and initial cognitive isolation.

## Verification

Exercise the actual simulation boundary with hidden initial properties, valid discovery, unavailable methods, failed actions, private facts and witnesses. Assert canonical state preservation, exact actor beliefs, no automatic future updates and replay equality. Import the authored sample and execute a live aptitude inspection with the configured provider; retain Ledger evidence and distinguish state qualification from presentation quality. Run focused tests and `npm run check:fast` before the local checkpoint.

## Evidence

The access schema, model transport and direct-world discovery path are implemented as `direct-world@8`. [Simulation-entry regressions](../../src/engine/direct/__tests__/runtime.test.ts) cover successful, partial, unavailable and failed examinations, actor-only knowledge, private-information exclusion, unchanged truth, historical belief and replay equality. The focused discovery, perspective, information-boundary and registry suite passes 171 tests. The [sample authoring workspace](../../worlds/fanren/authoring/README.md) owns the separate authored-content and live-run qualification; this feature alone does not qualify the full world.
