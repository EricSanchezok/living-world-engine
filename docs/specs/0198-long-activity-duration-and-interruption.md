# Long activity duration and perceptual interruption

Artifact-Version: 1
Status: Approved

## Intent

Make long rests, journeys and cultivation usable through the ordinary world runtime. The user's 2026-10-17 instruction to finish the approved world plan, exercise real play and fix the resulting failures authorizes this contract within [the world and participation scope](0195-canonical-world-and-participation-seeds.md). This contract covers elapsed duration, a participant's stated stopping condition, and causally ordered feedback. It does not grant cultivation progress, create calendar lore or suppress other characters' actions.

## Contract

- A requested elapsed duration remains bound to the selected activity. Explicit hours and days can span ordinary checkpoints and the autonomous initiative horizon. A checkpoint is not the requested duration and cannot silently replace it.
- Duration interpretation recognizes authored elapsed units alongside seconds, minutes and hours. Day, week, month, year and setting-specific terms require an authored unit length; a location-scoped definition takes precedence over a global definition along the actor's containing-place ancestry. Conflicting definitions at the same scope are rejected. This permits different local days and a shared age convention without silently multiplying lifespans. An undefined or ambiguous interval requires clarification, never a guessed duration, a short-profile substitute or immediate completion. Calendar dates, dawn, dusk and irregular calendars remain distinct from elapsed-unit arithmetic.
- The action reading preserves a stated interruption condition as part of the admitted activity. It may stop that activity when newly delivered perceptual evidence satisfies the condition, at the event's actual world-time boundary. Mentioning a possible future event does not satisfy it. Unrelated or inaccessible activity does not interrupt it.
- Interruption uses the ordinary semantic adjudication and perceptual admission paths. A model may judge what a delivered event means; the kernel owns event order, actual delivery, active-activity identity, time and cancellation. The runtime does not poll a model at every arbitrary checkpoint or add a separate mandatory per-turn call.
- A stopped activity retains its actual elapsed progress and prior committed consequences. Its uncompleted tail, future completion effects and reserved resource claims are cancelled. Repeated observation or recovery cannot apply those effects again. A fresh participant request remains the existing explicit interruption path.
- A stopping condition does not authorize an automatic answer, new expenditure, new destination or other voluntary action. The participant receives the event and the interrupted activity's factual result, then chooses what to do next.
- Long activity does not freeze other agents or bypass earlier timers, resource constraints, condition evolution or actual causal boundaries. An uneventful interval may advance to its next meaningful boundary without repeated model decisions. Authored cultivation and travel consequences must still follow the ordinary validated effects and conservation rules.
- Published feedback uses observations available at its own boundary. Earlier publication cannot acquire later results because generation finishes after a long time jump. Later completion cannot erase an earlier delivered reply or describe an interrupted interval as completed.
- Narrative receives the boundary's resolved elapsed-unit terms and seconds, without canonical location identifiers. Subject-specific property evidence carries its observation boundary where known. Successful observation findings remain intact; old or other-location properties cannot override a new finding, and unit conversion cannot change the admitted elapsed duration. Temporal grounding stays within the existing publication batch.
- This is a generic forward-only runtime and world-script contract. No work-specific engine branch, migration or fallback producer is introduced. Updated persisted contracts receive their normal version changes.

## Plan

Bind elapsed units and stopping conditions in action interpretation; adjudicate eligible interruption against real event delivery; cancel unfinished activities through the existing transaction and control record; preserve boundary-specific narrative context. Add authored duration-unit validation at the world contract and exercise the real import, host and replay paths. Keep calendar evolution in world authoring.

## Verification

Use paired real-entry tests for an eight-hour quiet activity, an early addressed call, an unrelated conversation, an inaccessible call, and a later event after completion. Verify exact elapsed time, actual observation delivery, no completed tail effects, unchanged conserved resources, replay equivalence and no automatic participant reply. Check a continuing activity through restart and explicit replacement, authored month/year units, absent-unit clarification, compound duration arithmetic and exact requested duration. Confirm an already published observation does not gain a later outcome and ordinary continuation/recovery use equivalent prior observations.

Run focused engine, loader and host tests, world validation, and `npm run check:fast`. Actual model qualification records world time, wall time, acting population, physical calls, transport execution and queue time, first rejection, repair recovery and terminal failures. A short or sampled trajectory is not whole-world scale acceptance.

## Evidence

The motivating live trajectory completed a requested eight-hour rest at 28,800 world seconds despite an earlier delivered direct address matching the player's stopping condition. [Long activity tests](../../src/engine/direct/__tests__/long-activities.test.ts) now cover conditional interruption, inaccessible and unrelated events, newly admitted listeners, completed work, exact intervals, restart, resource cancellation and replay. [Host tests](../../src/server/__tests__/direct-world-host.test.ts) reconstruct an earlier scene after later completion without acquiring later holdings or cognition. The [incident analysis](../postmortems/0175-long-activity-conditions-and-publication-boundaries.md) records the distinct escape mechanisms. Local Ledger evidence and model transcripts remain in the ignored validation cache until their acceptance report is complete.
