# Preserve the Finite Work Experiment World

Artifact-Version: 1
Status: Approved

## Intent

Restore the finite-work source capability required by [the checkpoint experiment](0045-short-action-checkpoint-world.md) at the [complete player diagnostic](0122-player-action-efficiency.md) entry. Correctness and performance qualification remain separate from the presence of this authored option.

## Contract

The isolated player world is constructed from the bundled source, an explicit finite-work YAML fragment, and the two declared short-action checkpoint transformations, in that order. The fragment preserves the established work-until-objective goal profile, its 300-second progress interval, finite-work coverage and source calibration. The interval does not establish completion or eliminate intervening actions, timers, conditions, reactions or interval effects. No action is automatically assigned to the profile, rewritten or delayed to improve a measurement.

The checkpoint transformation requires that complete finite-work capability before changing either short profile. Missing or inconsistent profile, coverage or calibration fails before model access. Reverse the declared fragment additions and short-profile transformations to recover the complete original source exactly. Source entities, Agents, laws, participation, model settings, remaining mechanics and immutable historical snapshots retain their identity and contents.

The integrated preparation records the recipe identity and content hashes of the fragment and both transformations, validates the persisted world through the normal loader, and verifies the finite-work capability in that reloaded definition. A fresh world hash and data root identify the repaired experiment; no old save or recorded invocation is resumed under changed semantics. The bundled world and production default remain unmodified.

## Plan

Represent the established authored additions in one tracked YAML fragment. Compose the existing checkpoint transformation through one shared helper used by the player entry. Require the prerequisite at the transformation boundary and capture it in preparation evidence. Preserve historical failure evidence and [the postmortem](../postmortems/0133-integrated-world-omitted-finite-work.md).

## Verification

Exercise the player entry's world construction and persisted loader boundary. Assert all 48 original Agents and every unrelated source field survive, all three goal profiles exist with their exact distinct intervals, finite-work coverage and calibration survive, and corrupt or incomplete prerequisites fail before any model invocation. Preserve short completion, continuing checkpoints, explicit durations and the existing interval-receipt tests. Run relevant tests and check:fast before committing.

A subsequent prospective compilation comparison may use the complete original 49-action preparation and its five initial compiler batches with a separately identified finite-work world overlay. Fix complete source actions, source state, model catalog, current producer and ordered request bodies before dispatch. Permit at most ten primary calls, one per arm and original batch, with DeepSeek Flash and thinking disabled, no repairs or retries. Preserve every response, usage, profile selection, mechanical rejection and source-semantic concern. Added profile selection is not proof of correct timing; no source replay, compilation success or longer selected checkpoint qualifies as full-player acceleration. Fresh full-player validation remains required.

## Evidence

The [49-Agent boundary probe](../../src/engine/benchmarks/step-efficiency/boundary-frontier-probe.ts) separates repeated new actions from repeated goal checkpoints. Both can lengthen a player's serial commit chain while unrelated occupied Activities retain their absolute boundaries. Its scripted results establish scheduling behavior only.
