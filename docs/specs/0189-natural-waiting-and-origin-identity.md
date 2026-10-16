# Natural waiting and Origin identity

Artifact-Version: 1
Status: Approved

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

Implementation evidence is recorded after the regression and live checks complete.
