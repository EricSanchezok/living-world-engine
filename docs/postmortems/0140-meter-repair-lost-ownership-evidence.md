# Meter Repair Lost Ownership Evidence

Artifact-Version: 1

## Executive summary

A forty-nine-subject player diagnostic failed after a remote reconnaissance plan repeatedly assigned one character's vitality meter to a different target. The materializer rejected both effects correctly, but its generic error identified only an internal effect ID. Repair received neither the exact failed field nor the meter's actual owner or compatible choices. The player waited 260 seconds without feedback or a world commit.

## Summary

Execution 84f8e8fa-b1d6-4fa4-b1ff-d87ade29d24f stopped before transition generation. The complete diagnostic made forty-two physical model requests, including sixteen marked as semantic repair attempts. Canonical state, revision and step remained unchanged. These observations identify a failed execution and do not establish a latency improvement.

## Timeline

- The initial reconnaissance plan omitted required success and failure effects.
- Parsed sequence 651 described crew attrition but selected an unrelated lost dog as the effect target and the commander's vitality as its meter. Rejection 657 reported a generic invalid meter effect.
- Parsed sequence 717 changed the target to the fleet but retained the commander's vitality meter. The fleet had no meter; rejection 720 exhausted repair and the joint step rolled back.
- A real SimulationEngine reproduction distinguished wrong ownership, an incompatible profile and an entity without meters. The original diagnostic failed all three field-evidence assertions.

## Root cause

Existing handles can form invalid relationships even when every individual reference resolves. The meter validator combined missing meters, wrong ownership and incompatible impact profiles into one generic exception. This erased the precise property path and the relationships needed by the existing bounded repair loop. An unrelated selected target could also look mechanically valid if repair merely changed its meter; legal ownership cannot certify that a subject is relevant to the original action.

## Guardrails

- [Meter-effect validation](../../src/engine/mechanics/truth-engine.ts) reports the exact plan/effect field, selected meter and visible owner, meters belonging to the currently selected target and compatible impact profiles. Empty meter domains remain empty. Ownership and profile failures are collected together without changing a reference or weakening rejection.
- The diagnostic distinguishes the draft's selected subject from the original intended subject. It requires checking the action and world evidence before selecting a legal combination, and retains evidence-supported non-meter consequences where applicable.
- [Real-entry repair coverage](../../src/engine/mechanics/__tests__/meter-effect-repair-evidence.test.ts) verifies field-specific evidence, an unchanged intended target and consequence, no damage transfer to an unrelated actor, an open condition on an entity without meters and exact state replay.
- [Bound relation selection](../specs/0114-bind-planning-relation-choices.md) remains a separate experimental representation. Its historical mechanical screen did not pass; clearer rejection evidence does not qualify that representation or establish complete gameplay success.
