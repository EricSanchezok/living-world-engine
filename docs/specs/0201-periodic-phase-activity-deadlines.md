# Periodic phase activity deadlines

Artifact-Version: 1
Status: Approved

## Intent

Complete natural long-activity requests whose endpoint is an authored periodic phase, such as resting until the next daylight phase. The user's 2026-10-17 instruction to finish all work and repair actual play failures authorizes this generic extension of [elapsed activities](0199-long-activity-duration-and-interruption.md) and [periodic properties](0200-authored-periodic-world-properties.md). A live request to rest until the following morning instead completed two short waits while it was still night. Explicit-hour acceptance does not cover this failure.

## Contract

- The existing action interpretation batch distinguishes an elapsed interval, a periodic phase endpoint, ordinary step timing, and an unresolved endpoint. It binds only the next actually requested step; quoting a deadline or asking what a phase means does not authorize waiting.
- Public periodic rules for the actor's current containing-place ancestry may supply phase endpoint choices. A present observation of a restricted property does not reveal its future cycle. Restricted cycles without an explicit supported schedule-knowledge grant remain unavailable for deadline prediction; they require clarification or a separately supported open condition wait. Missing schedule knowledge never falls back to a short completed wait.
- Choices contain local labels and public phase descriptions, not canonical entity or property identities. They distinguish the current phase from the transition's ending and beginning phases, and label the next or later occurrence from the request boundary. Identical inherited public rules can share one choice set without discarding different local rhythms. Each transition appears once. Semantic interpretation independently binds the entering phase and a relative-cycle offset or a transition-occurrence number; the engine computes the corresponding positive integer deadline from the authored period, phase origin and phase offset. Calendar-relative language and occurrence-relative language are distinct: a following-cycle endpoint need not be the next occurrence of that transition. The model does not select a duplicate phase indexed by a precomputed deadline.
- Relative-cycle offsets and transition occurrence numbers support ordinary phase language and explicit larger ordinals without candidate enumeration or silent clamping. An unrepresentable integer or a calendar reference not determined by the authored cycle requires clarification. No work-specific word matching or assumed universal day length determines the endpoint.
- A submission's cycle references remain anchored to its initial action boundary across prerequisites and continuation. Completed work cannot be repeated by silently moving a deadline to another cycle. A selected deadline already reached during earlier steps requires clarification of the remaining intent rather than retroactive effects or a new full-cycle wait.
- Once admitted, the deadline is an exact elapsed duration in the ordinary activity record. It crosses checkpoints without polling, remains stable through preparation invalidation and restart, and shares normal scheduling with other characters and environmental changes.
- An explicit early stopping condition can coexist with the phase deadline. Actual delivered evidence may interrupt the unfinished activity; elapsed progress remains committed and unperformed completion effects remain cancelled. Later events cannot rewrite an already completed phase wait.
- Completion does not grant observations through walls or reveal hidden future state. Narrative uses the actual completion boundary, elapsed-unit mapping and admitted observations. Unsupported endpoints advance no physical time and do not claim success.
- This is a forward-only generic runtime extension. It adds no world-specific branch, extra mandatory model invocation, compatibility path, or chapter-based event schedule.

## Plan

Build public local phase candidates with deterministic exact arithmetic, bind them in the existing duration field, and preserve the resulting deadline through the existing activity path. Add an explicit unresolved selection and boundary-specific explanation. Keep elapsed duration and phase endpoint candidates distinguishable in the interpretation context. Preserve private-cycle isolation and source IDs inside trusted engine code.

## Verification

Exercise real engine entry paths for a human-length next daylight boundary, a longer local cycle, the following occurrence, an explicit large ordinal, a compound request with a prerequisite, and interruption before the target. Verify exact time, unchanged conserved resources on cancelled tails, restart and replay. Pair public and restricted cycles; observing the restricted current value alone must not reveal its future phase schedule. Check overflow and unknown endpoints without short substitute activities. Verify a later observation and ordinary phrases containing incidental numerals remain ordinary actions.

Repeat the actual-model request that failed, plus explicit-hour and conditional interruption regressions. Record context and token changes, physical calls, transport and queue time, first rejection, repairs and terminal failure separately. Run focused checks and `npm run check:fast` before the containing implementation unit is committed.

## Evidence

The failed live request retained its literal endpoint in both action expressions, yet both frames used a judged 300-second duration and the host reported the root activity completed at 600 seconds while the local periodic fact remained night. The immutable Ledger and narrative record are retained in the ignored playtest cache. This contract addresses that runtime failure rather than relabeling the short waits as successful overnight rest.
