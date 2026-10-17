# Effect candidates disclosed destination knowledge

Artifact-Version: 1

## Executive summary

Bounded merchant play exposed destination knowledge to a player who only witnessed another character's departure. The movement committed correctly, but unchanged properties considered during adjudication escaped the actor-only incidental-perception boundary. The correction separates a property considered for an effect from an effect actually performed, without adding model calls.

## Summary

Instance `c0c964d2-c158-4098-903e-0338726c9e86`, produced by `direct-world@14`, reached world time 360 seconds with the manager in the stockroom and unchanged quantities. At revision 6, time 300, the hall player's own observations contained four route properties and the night condition of the remote shop. The narrator received these observations through its correctly owner-filtered source. After creative continuation failed, the factual fallback printed the shop properties twice, once for each mover's observation. This was not a narrator importing another Agent's private state directly.

The run stopped after its first input and 30 HTTP requests. The report, complete Ledger and immutable snapshots remain in the local qualification cache. Stock inspection, return, report and conditional-wait completion were not exercised. Correct movement and resource conservation did not qualify the run as natural play.

## Timeline

1. The live run showed successful movement into the shop and stockroom, followed by a narrative fallback containing remote routes.
2. Ledger integrity and source inspection established that the player's own committed observations already contained those facts.
3. A zero-network replay reproduced the observation packets, publication source and fallback from the saved boundary.
4. Inspection of the world-to-perception handoff identified the classification of unchanged effect candidates as the first faulty boundary.

## Root cause

World adjudication collects the actor's, target's and tool's existing properties as possible effect candidates for movement, use and change. The incidental-perception calculation excluded every candidate from its actor-only set before the answers established whether the property changed. For a move, the destination itself is the target, so its unchanged routes and local conditions entered this exception.

The visibility question established that the acting character could perceive those facts. Separate contact questions established that a nearby observer could see that character. Perception combined these two answers and distributed every public fact outside the actor-only set. Neither answer granted the observer access to the remote destination's unchanged properties.

Earlier tests covered private facts, reference-only introductions, actual arrival and inventory measurement. They did not combine visible departure with unchanged public properties of a destination. Narrative source filtering and factual checks could not repair information already admitted into the observer's own evidence.

## Guardrails

[Autonomous work regression tests](../../src/engine/direct/__tests__/autonomous-work.test.ts) exercise actual movement through the direct simulation boundary: the mover retains admitted destination perception, the departing witness does not acquire unchanged destination facts, existing witness knowledge remains intact, and actual admitted property changes retain their established delivery path. [World adjudication](../../src/engine/direct/world.ts) owns the separation between effect candidates and committed changes. The behavior is identified by the current [direct-runtime producer](../game-design/direct-runtime.md); the original version-14 evidence is not relabeled.

This correction does not establish that seeing an actor always permits seeing every remote effect. More general recipient-specific effect visibility remains outside this regression's conclusion. The observed repeated elapsed-time prose also remains a separate generation failure: the saved requests already contained the correct clock receipts and published prefix. Local regression success does not substitute for fresh natural-play qualification.
