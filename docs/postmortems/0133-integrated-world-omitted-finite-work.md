# Integrated world omitted the finite-work capability

Artifact-Version: 1

## Executive summary

The full-player diagnostic constructed its checkpoint world directly from the bundled world, omitting the finite-work profile and calibration present in the checkpoint experiment's intended source. The resulting immutable definition exposed only one-second and ten-second goal profiles. A valid short-profile transformation and passing world-schema checks did not establish that the complete experiment had been assembled.

## Summary

The missing option constrained temporal selection for compound finite work and invalidated assumptions that the earlier finite-work design was available in full-player tests. Its precise effect on model choices, repair and latency is unmeasured. The recorded player execution failed before a world commit; it does not demonstrate repeated live checkpoints or a known completion time.

## Timeline

- The finite-work experiment declared work-until-objective with a 300-second progress interval, coverage and calibration.
- The short-action checkpoint experiment preserved that complete source while converting two generic short profiles.
- The integrated player entry reconstructed from the bundled source and applied only the short-profile transformation.
- Execution 14c18986-48ed-40ce-9bc8-0f3caf542273 recorded the incomplete definition at Ledger sequence 301 and its one-second planning boundary at 317.
- A 49-Agent scripted boundary probe separated repeated fresh actions from repeated checkpoints, prompting inspection of the original profile catalog and archived experiment source.

## Root cause

The short-profile transformation accepted any otherwise valid source world. Its isolated default pointed to the finite-work variant, but the integrated caller supplied the bundled world. The helper verified reversibility of its own two-profile edit without checking the semantic capability its experiment required. Its tests also prepared a bundled-derived source and asserted local changes and unchanged profile cardinality, so they accepted the incomplete composition. The integrated manifest bound the resulting world hash but did not bind the prerequisite recipe; a hash proves which world executed, not that it was the intended one.

In the recorded context, both the external player's ten-second boundary and Azure King's one-second boundary were goal checkpoints with null completion times. Calling those known task durations would overstate the evidence. The scheduling probe's fixed ten-second player wait is a distinct controlled task, not a replay of the lodging inquiry.

## Guardrails

[The experiment-world contract](../specs/0138-preserve-finite-work-experiment-world.md) owns the explicit fragment, ordered composition, prerequisite rejection, persisted verification and claim limits. The [checkpoint entry tests](../../scripts/experiments/step-checkpoint-world.test.ts) exercise complete preparation, missing capability and immutable reload. The [player world tests](../../scripts/experiments/player-integrated-world.test.ts) verify the same shared construction used by the real player entry and retain complete source equality outside the declared additions. The runtime does not infer profile choices or modify historical worlds.
