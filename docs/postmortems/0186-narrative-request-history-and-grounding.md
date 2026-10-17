# Narrative request history and grounding

Artifact-Version: 1

## Executive summary

A later wait-completion paragraph could erase an earlier delivered refusal. Payment publication also confused the transferred amount with the remaining balance. The scene contract now supplies ordered observations from the same participant request, and publication respects its configured inference profile.

## Summary

Live merchant and aptitude-examination sessions preserved the canonical transactions but sometimes published a fallback or an inaccurate continuation. A five-unit payment left thirty-five units, yet the grounding decision rejected the correct description. A request received a refusal before its wait ended, but a later paragraph described the interval as unanswered. Handling cups also became an unsupported refill or departure in some drafts.

## Timeline

1. The rebased direct runtime passed state, conservation and replay checks, while real sessions exposed narrative defects.
2. Frozen scenes reproduced balance confusion, erased replies and invented gestures. Prompt clarification alone did not reliably resolve them.
3. The ordinary outbox path received the same ordered, isolated prior-request observations already available to recovery. Earlier events are explicitly distinguished from newly executed actions.
4. With this layout held constant, twenty-seven publication decisions were repeated using the profile's configured reasoning. Correct decisions increased from twenty-one to twenty-six. This is a bounded comparison, not a universal accuracy estimate.
5. A new merchant session committed the payment and published both resulting paragraphs, with one rejected draft repaired. The examination session continued to require further player action; it is not recorded as a successful aptitude test.

## Root cause

The ordinary continuation path omitted prior observations from its request, leaving a model to reconstruct events from less structured discourse. The publication layer also forcibly disabled reasoning despite the selected profile. Its evidence instructions did not separate a transaction's moved amount from the balance after the transaction.

## Guardrails

[The outbox](../../src/server/narrative/outbox.ts) collects only the same participant, agent and submission, excludes explanatory replies, orders observations by their actual boundary and deduplicates identities and source events. [Scene tasks](../../src/server/narrative/scene.ts) label these as historical evidence, retain delivered speech and keep the newly executed actions separate. [Publication](../../src/server/narrative/publication.ts) uses the configured profile and independently checks material, action, evidence, speech and reference fidelity.

[Host tests](../../src/server/__tests__/direct-world-host.test.ts) cover an ordinary wait following a delivered refusal. [Narrative tests](../../src/server/__tests__/world-narrative.test.ts) cover recovery equivalence, isolation, event order and duplicates. These checks preserve the player's information boundary without erasing actual history.

## Evidence

The [bounded model comparison](../../worlds/fanren/authoring/validation/narrative-publication-comparison.json) records equal call counts, transport attempts, tokens and separate queue and execution time. Configured reasoning used more tokens and transport time; it added no publication call. One conservative rejection remains in the frozen cases, so repaired live publication and failure tracking remain necessary. The integration checkpoint passed 379 test files and 2,542 tests, including the 74 focused host and narrative cases.
