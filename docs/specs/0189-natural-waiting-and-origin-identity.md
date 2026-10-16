# Natural waiting and Origin identity

Artifact-Version: 1
Status: Implemented

## Intent

The user's approved correction separates ordinary reading and decision time from interrupted execution, removes Blackmarsh's obsolete default player, and prevents entity annotations from repeating their visible noun phrase. Work stays in the main checkout with real-model validation on a fresh world snapshot.

## Contract

- A single externally controlled Agent's ordinary decision window has no wall-clock deadline. Multi-participant collection and reaction windows retain their configured deadlines. Reading and refreshing do not advance the world or spend model calls.
- Quiescence is a successful execution with no canonical commit. A controlled world returns to `awaiting-decision`; an Observer run completes. Neither offers resume. Explicit pauses, budget pauses and interrupted-process recovery remain distinct resumable states. An explicit new action may interrupt a quiescent ongoing intent through normal adjudication.
- Blackmarsh contains its autonomous cast and no reserved player entity. Origin admission creates the sole new player identity. Remove obsolete NPC attitudes, local identities, bindings, testimony and claims about the default player without prebinding NPCs to a future admission.
- Entity reference markers replace their visible phrase. Publication suppresses an exact repeated phrase immediately adjoining an annotation, preserves its local identity, and leaves unannotated text and delivered speech unchanged.
- Existing world catalogs and saves remain immutable snapshots. Real acceptance uses a fresh data root at the current schema with the previous root preserved; there is no compatibility renderer, migration or alternate character-creation path.

## Plan

Correct WorldHost deadline and quiescence transitions and verify ordinary input versus real pause. Remove the script-owned default player and references, correct narrative token rendering and its prompt, and validate through real persistence, replay and model transport.

## Verification

Cover idle reading, restart, quiescence without a commit, new input after waiting, genuine pause/resume, multiplayer and reaction deadlines, complete Blackmarsh admission, reference-boundary repetition and literal speech. Run focused tests, `check:fast`, `check:ui`, bundled-world validation and a fresh real-model game.

## Evidence

- [Direct host regressions](../../src/server/__tests__/direct-world-host.test.ts) cover successful quiescence, notification and execution linkage, later input, deadline-free solo reading and restart, and one Origin admission alongside the complete autonomous cast. [Host lifecycle regressions](../../src/server/__tests__/world-instance-host.test.ts) preserve explicit pause/resume and timed reaction fallback.
- [Narrative publication tests](../../src/server/__tests__/world-narrative.test.ts) cover both annotation edges, exact observed repetition, distinct identities, word boundaries and literal speech. [World content tests](../../src/server/__tests__/blackmarsh-world.test.ts) and [snapshot preparation tests](../../scripts/experiments/step-checkpoint-world.test.ts) preserve the complete source world without the obsolete reserved player.
- [Participant browser flow](../../e2e/flows/immersive-game.spec.ts) verifies normal input has neither a pause label nor a resume button. `check:fast` passes with 2,381 tests across 360 files; `check:ui` passes with 12 browser flows and four accessibility checks. Blackmarsh validation reports 231 initial entities and 47 autonomous Agents.
- Fresh Blackmarsh 1.2.0 live qualification on 2026-10-16 used TypeSafe `jev-1.13.0` and DeepSeek `deepseek-flash`. Three actions published complete narration on their first presentation attempt. One admission created the sole controlled identity; no legacy player or predefined NPC binding remained. Explicit pause cancelled the in-flight request, resume committed the action once, and canonical replay matched. After the second turn, 65 seconds of idle time and three reads preserved revision, world time, suggestion source and the model invocation count. The previous data root remains archived locally.
