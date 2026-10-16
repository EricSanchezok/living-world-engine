# Reserved player and repeated entity labels

Artifact-Version: 1

## Executive summary

An Origin-created Blackmarsh player observed a second traveler matching the expected player role. The world package still contained an obsolete default player, and narration appended an entity annotation after its visible phrase, producing a repeated label. Removing the reserved entity and its cognition references restores one admission path; scoped annotation rendering prevents the textual repetition.

## Summary

The controlled Agent was `harbor-wayfarer-1`, while the traveler described beside the harbor steps was a separate canonical entity, `player`, controlled by a model policy. Six NPCs also retained predefined local identities and attitudes about this obsolete newcomer. The displayed phrase repeated because creation emitted `旅人[[entity:seen-18b266ce1c16c6074e3d1674|旅人]]`; an awning reference had the same defect.

## Timeline

- Origin admission created the named player while preserving every entity in the bundled package, including the old default traveler.
- Execution `58821a7c-7dc5-492a-a28c-0d55840fcc1d`, event 148, recorded the duplicated annotation in the parsed narrative response.
- The player reported uncertainty about whether the extra traveler was another copy of themselves.
- Regression tests failed on the reserved cast member and annotation-adjacent repetition before either fix was applied.

## Root cause

World content retained a player surrogate after Origin became the normal admission path. Loader validation correctly accepted it as a valid autonomous Agent, and the integration test incorrectly expected the enlarged cast. Existing content documentation also described initial player testimony that Origin did not provide. Separately, reference validation established the correct local identity but treated every annotation as additional visible text, while the prompt did not explain that its surface replaces the phrase.

## Guardrails

- [Blackmarsh host coverage](../../src/server/__tests__/direct-world-host.test.ts) loads the complete package, requires 47 autonomous subjects, rejects the reserved player and newcomer references, and proves admission adds exactly one externally controlled self identity without changing NPC bindings. Decisions and committed state still replay through the real engine.
- [Snapshot preparation coverage](../../scripts/experiments/step-checkpoint-world.test.ts) verifies immutable complete source assets and permits only the declared mechanics transformation. Preparation and playtest tools derive cardinality from their pinned source instead of retaining the obsolete cast size; historical recorded probes retain their original source contracts.
- [Narrative publication regressions](../../src/server/__tests__/world-narrative.test.ts) cover the recorded traveler and awning patterns, both annotation edges, distinct identities with equal labels, ordinary repetition, word boundaries and literal delivered speech.
- [Narrative prompt](../../src/engine/prompts/system/scene-narrative.md) defines replacement semantics; [player content contract](../../worlds/blackmarsh/docs/design-brief.md#玩家边界) defines Origin as the only source of a newly created player.
