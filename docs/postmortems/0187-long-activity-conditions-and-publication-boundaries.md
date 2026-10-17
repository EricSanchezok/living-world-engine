# Long activity conditions and publication boundaries

Artifact-Version: 1

## Executive summary

A live eight-hour rest completed despite an earlier delivered call matching the player's explicit stopping condition. Investigation also found that delayed narrative construction used the latest state for historical observations. The runtime now persists conditional interruption, checks actual delivery, and reconstructs each narrative source at its own committed boundary.

## Summary

The participant requested eight hours of rest, stopping if directly addressed or exposed to obvious danger. Another character's direct speech reached the participant at sixty world seconds. The rest nevertheless completed at 28,800 seconds. One narrative draft also claimed nobody had called; publication rejected that draft, but correcting prose could not undo the incorrect duration.

The outbox separately combined a historical receipt with current holdings and cognition when the world advanced before narrative construction or recovery. That layout could place later knowledge or results into an earlier scene. This second mechanism was confirmed through a host regression; its presence in code does not establish that every delayed live paragraph leaked future information.

## Timeline

1. Duration and explicit replacement tests passed, but did not include an event satisfying a natural-language stopping condition.
2. A real long-rest session delivered a call at sixty seconds and completed the rest at 28,800 seconds. Ledger replay reproduced the state, separating an engine contract omission from a transient model response.
3. The action and world paths were traced through activity admission, prepared effects, delivery and intent waking. The condition had no persisted executable owner.
4. The same investigation traced historical observations through delayed publication. The outbox read current cognition and holdings rather than the observation revision.
5. Paired real-entry regressions added addressed, unrelated, inaccessible, late and previously prepared events, resource cancellation, restart and historical publication recovery.
6. Fresh long-activity qualification exposed two publication errors: ten elapsed hours became ten traditional double-hours, and an observed daytime result became night. Canonical time and periodic state were correct in both cases.
7. After those repairs, a natural request to rest until the following bright phase completed at 600 seconds while it was still night. Both action expressions retained the endpoint, but the duration catalog contained no phase-bound choice. The exact-hour tests had not exercised this distinct interpretation path.
8. The first phase-enabled live run reached the next morning correctly, then interpreted a request for the following evening as a second entry into daytime. The candidate arithmetic was exact for the wrong semantic choice. Bare phase descriptions did not distinguish entering a phase from its end. A factual fallback also omitted a daytime finding delivered with a completed wait.

## Root cause

Conditional interruption was present only in natural-language text. Waking an active intent recorded an interaction for later but did not stop its current activity. The normal completion path consequently applied the full duration and would have applied any completion effects. The failure escaped because retained deadlines and explicit replacement were tested without a semantic stopping condition and actual observation delivery.

Historical publication had a different ownership error: the receipt carried a revision, but adjacent narrative context came from the latest document state. Asynchronous generation and recovery widened that mismatch during long jumps. Prior-request receipts also needed an upper revision boundary, because later receipts can already exist when an earlier one is recovered. Tests previously checked the latest scene and request-history isolation, not rebuilding a missing earlier scene after subsequent state changes.

The additional publication errors came from missing and lossy context. Narrative received elapsed seconds without the setting's authored unit conversions. Its generic description adapter also discarded the first summary line as an attempted action, although a successful observation can put its only new finding on that line. The remaining property list mixed subjects and evidence ages. Old night observations therefore survived while the new daytime finding disappeared. Broad result grounding did not reliably detect these temporal contradictions.

The natural phase endpoint exposed a candidate-domain omission. Literal elapsed units were supported, but periodic target language could only select ordinary timing. Its meaning survived in prose without an executable deadline. Completing a few short waits did not fulfill that target. The fix binds the public phase occurrence in the same interpretation batch and computes its exact deadline; unsupported endpoint language has an explicit unresolved path.

Adding candidates alone did not establish faithful interpretation. An ongoing phase and the transition into it used the same description. The model could retain the requested endpoint in its prose while selecting the opposite boundary. Candidate layout now names the current phase, the phase that ends, the phase that begins, and which occurrence is intended. A paired real-model probe reused the failed request context and unchanged system/schema across five requests with three repetitions per layout. The original layout selected 12 of 15 correctly, failing all three following-evening cases; the transition layout selected all 15 correctly. Both used 15 calls and transports. The layout added 220 input tokens per call in that recorded context, with no additional adjudication call. Fresh end-to-end qualification remains necessary because this probe does not certify later narration or autonomous behavior.

A later live chain selected the current evening for a request naming the following evening. Adding request-cycle offsets alone still failed one of fifteen requests in each of two complete failed contexts. The model had to interpret the cycle and then remap it to an opaque duplicate occurrence choice. The final layout exposes each entering phase once and binds the temporal reference separately as a relative-cycle offset or occurrence count. The engine computes the deadline directly. Two rounds over both preserved contexts selected all sixty requested interactions correctly, with sixty-one physical calls and one JSON-output repair in the second round. A context-reduction ablation selected twenty-nine of thirty correctly, so the fuller phase context was retained. These probes do not replace fresh live qualification.

Fallback had a separate action-kind filter: it preserved phase findings only for observation actions, although other completed actions can produce authorized perceptible feedback. It now uses the same executed-evidence projection as narrative publication and removes only the separately rendered scene tour. Attempt text from a blocked action remains excluded.

## Guardrails

[The approved contract](../specs/0199-long-activity-duration-and-interruption.md) separates elapsed duration, semantic matching, actual delivery and cancellation. [The kernel](../../src/engine/direct/interruption.ts) requires an active identity and a delivered triggering event. It retains elapsed progress, cancels unperformed effects and leaves the participant waiting for a new choice. [Prepared matching](../../src/engine/direct/world.ts) remains in the existing adjudication batch and is refreshed when a new eligible activity appears.

[Long activity tests](../../src/engine/direct/__tests__/long-activities.test.ts) exercise the real engine with only external model HTTP replaced. They verify exact elapsed time, inaccessible evidence rejection, cancellation of unperformed material consumption, unchanged completed work, restart, replay and call count for an uneventful interval. Undefined calendar units and a noninterruptible profile cannot silently substitute another activity.

[The outbox](../../src/server/narrative/outbox.ts) reconstructs cognition and holdings at the receipt revision and bounds earlier-request observations by that revision. [Host tests](../../src/server/__tests__/direct-world-host.test.ts) rebuild an earlier scene after later completion and compare its holdings, boundary and memories with the originally captured source. [Narrative tests](../../src/server/__tests__/world-narrative.test.ts) reject future request receipts while retaining already delivered responses.

[Scene construction](../../src/server/narrative/scene.ts) preserves successful observation findings and supplies local elapsed-unit conversions and subject-specific property evidence boundaries. [Publication](../../src/server/narrative/publication.ts) checks temporal fidelity using the existing evidence question, without another model invocation or a seventh question axis. A paired six-versus-seven-axis diagnostic found no accuracy benefit from a separate temporal axis after the context layout was repaired; the additional axis was removed. Narrative regressions preserve a first-line daytime observation through generation, grounding and factual fallback; the host regression compares unit maps and evidence boundaries during historical recovery. Actual-model paired checks cover equivalent hour/traditional-unit expressions, incorrect conversion, fresh versus stale day/night statements, interrupted versus completed duration, and display versus possession transfer. These checks measure false rejection separately from unsupported text accepted for publication.

[Periodic deadline regressions](../../src/engine/direct/__tests__/periodic-deadlines.test.ts) exercise public cycles of different lengths, following occurrences, prerequisite anchoring, restart, replay and a delivered early interruption. Restricted current observations do not expose future schedules. Large ordinals remain exact references and overflow or unknown endpoints cannot silently become short waits. [The endpoint specification](../specs/0201-periodic-phase-activity-deadlines.md) keeps this distinct from elapsed-hour acceptance.

The phase regressions also distinguish the present phase's exit from its next and following entries, then run the selected later exit through actual scheduling and replay. Narrative regressions retain completion-time phase findings for wait activities while excluding a blocked attempt's unexecuted verbs. Real-model probes and live failures remain separate evidence from deterministic tests.
