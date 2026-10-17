# Action execution site binding

Artifact-Version: 1
Status: Approved

## Intent

Bind a requested activity's execution site separately from its semantic target. The user's 2026-10-17 instruction to complete and repair actual play authorizes this generic action-reading correction. A live request to rest in a known workroom produced a wait while the actor remained in a different containing place; its prose nevertheless asserted the requested room.

## Contract

- The existing player action reading identifies the site required for its selected next physical step using the same private local identities as other action parameters. The current placement and its exact known aliases are supplied as the execution boundary. A named room within a known residence is not automatically the actor's current room.
- An activity target is not an execution site. Waiting for a person, watching a distant object, and discussing a place do not request travel there. A location mentioned only in speech, a hypothetical branch or a future plan cannot authorize movement.
- A requested activity at a different known place requires a real movement receipt before it can execute there. The reading selects the authorized movement with ordinary travel timing and continuation, or an authorized prerequisite at the current place. The engine never turns a wait target into movement or treats an intended destination as an accomplished fact.
- A selected nonmovement activity whose bound required site differs from the actual place enters the existing bounded consistency repair. A persistently inconsistent reading fails without committing that activity or advancing its clock. An unresolved site or unavailable route may yield clarification; it must not silently substitute another site or a short completed wait.
- A selected activity already at its requested site executes without added travel. Completed movement changes the next reading's current site through the normal placement transaction. Compound requests preserve their original periodic deadline anchor and already completed receipts.
- The binding is an interpretation contract, not a new persisted world fact. It adds no mandatory model invocation, world-specific branch, canonical identity exposure, alternate movement implementation or save compatibility path.

## Plan

Add a required player-reading site field and a compact current-site boundary, and validate the selected execution branch before constructing its frame. Reuse the existing single consistency repair and ordinary movement settlement. Preserve autonomous intent and semantic targets independently of this player authorization check.

## Verification

Exercise the real engine with an erroneous different-site wait followed by a repaired move, then a rest at the committed destination. Pair this with a same-site wait, a spoken future plan, an unresolved site, and repeated inconsistent readings that commit nothing. Verify placement, elapsed time, continuation receipts and replay rather than model descriptions. Replay the complete failed model context with the new binding and run fresh live requests before acceptance. Record physical calls, first rejections, repairs, terminal failures, token use and queue/transport time. Run focused checks and the repository's full fast check.

## Evidence

The preserved live invocation `0fdb8c6b-fdfd-48ef-ad79-0b1fa2c4f7ad::rt:model-audit:6873e5906cbd8beaf83e9e7f002d05cc1241c91cc62c2d7e1432dd3e4883d939` spans Ledger events 16–30. Its action was a wait targeted at the workroom, while canonical placement remained at the residence. Both place identities were available to the reading; waiting correctly did not perform a move. Prompt-only paired probes corrected two of three different-site readings, which was insufficient evidence of stable binding.
