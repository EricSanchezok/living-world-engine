# Shared context and meter ownership in sample qualification

Artifact-Version: 1

## Executive summary

Actual Fanren play exposed three gaps hidden by successful import and initialization: redundant native context caused provider rejection, numeric effects were assigned to the action target instead of the meter owner, and a missing familiar route allowed an outward movement to bind the current home. Qualification retained these failures and checked committed state rather than accepting narrative success.

## Summary

The first spirit-merchant instance `a1c7217b-9807-4e22-ab9c-ff0ed8e0d606` retained its 1,200 mana after attempted levitation. Its native decision failed with `max_tokens_exceeded`, and the language fallback was truncated. A context-only rerun, `59944fbd-4ebe-4d30-a1ad-28ae310d4763`, accepted the physical method but still failed to debit mana. This separated a transport failure from a deterministic ownership bug.

Han Li instance `8ad41d3c-80fc-4be4-9948-a45bfb6c706e` committed movement to `han-home` while its prose described reaching a village path. The initial private catalog contained the home and family but omitted that familiar path. The movement target instruction also allowed the current location without sufficiently distinguishing movement within it from travel elsewhere.

## Timeline

1. ZIP import, reciprocal cognition, property ownership and existing-identity tests passed.
2. Real-model actions produced the failures above. Ledger integrity checks found no missing evidence or corrupt references.
3. Invocation `27d3879b-9c9b-4e1a-96c8-b3c28a50704b::rt:model-audit:0b8f462207efb512bee6fbf31f018d9b9784052e5d81d957f70085e24f38b1b9` identified the native rejection. Its exact 89-question input was replayed with shared policy and action references; all answers returned in one native dispatch.
4. A fresh merchant playtest after that transport repair still retained unchanged mana, exposing the independent target-only meter lookup.
5. Meter adjudication was bound to each actual actor/target/tool meter, familiar-route knowledge was authored explicitly, and movement interpretation was constrained to a matching destination.

## Root cause

The native serializer copied a common policy into each question. World producers also embedded full action frames in many question payloads. Neither duplication added evidence. Existing large-input tests exercised a large shared state, not repeated policy overhead across many questions.

Numeric adjudication selected one impact profile and then looked for its meter on the target, falling back to the actor only when there was no target. A spell targeting an object therefore could not charge its caster. The absence of a matching target meter silently discarded the chosen effect. The single-impact structure also could not express a caster cost and target damage together.

Authoring supplied relationships and hidden abilities but did not fully supply everyday spatial knowledge. The interpreter then selected a valid but semantically wrong catalog key. Transaction validation correctly preserved that key, so successful commit and narrative text could not establish successful travel.

## Guardrails

- [Decision regressions](../../src/engine/models/__tests__/decision-v2.test.ts) preserve all 89 questions, criteria, authorized state, collision handling and one-call dispatch while checking wire reduction.
- [Actual simulation-entry tests](../../src/engine/direct/__tests__/runtime.test.ts) check action-reference resolution, actor costs alongside target effects, one debit when actor and target coincide, and replay.
- Numeric selection uses only existing meters on the actor, target and tool, with matching authored impact profiles. Code retains clamping, references and atomic commit; no setting-specific branch was added.
- [Sample entry tests](../../scripts/world-authoring/fanren-sample.test.ts) require Han Li's familiar-route binding while retaining hidden-root isolation and unique identity.
- [Live qualification records](../../worlds/fanren/authoring/validation/initial-live-runs.json) preserve the initial failures. Source, sample and whole-world completion remain separate statuses.
