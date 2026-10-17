# Minimum time and muted world feedback

Artifact-Version: 1

## Executive summary

Real play felt mechanically fragmented: multi-step movement and speech consumed only seconds, ordinary actions exposed little context, and nearby actors rarely initiated useful interaction. Duration fallback, player-only admission and narrow perceptual candidate enumeration compounded conservative prompts. The repair uses existing semantic adjudication for time and incidental perception, admits relevant NPC opportunities and preserves causal responses without a new director or continuous background simulation.

## Summary

The pre-change real-model instance `1e466910-0b30-4bdb-a68a-0339f725da11` consumed 4 and 5 world seconds for two travel/search/dialogue requests, with 20 and 24 model invocations. One publication call exhausted its output allowance on reasoning and required repair. The first revised play session, `2f7b846e-a85e-41e6-9149-3020ddd2fdd8`, used plausible 20/30/60-second increments but still failed to produce contact over three requests. This exposed candidate-selection and independent-field binding problems that prompt changes alone did not repair.

## Timeline

1. On 2026-10-17, the player reported repeated minimal progress and weak world initiative.
2. Baseline play reproduced short world-time increments and long publication latency. Invocation `652affd5-24a9-47ad-9ad9-acfe26bfe8a1::rt:model-audit:a73e362e7345d52afdf72fe9da2985d2b35d9b549bb43a093769bc3690ecc2f9`, Ledger sequences 2338–2350 in the archived v30 root, exhausted 8,192 reasoning tokens with no valid result.
3. The first tuning pass removed minimum-duration fallback and enabled incidental perception and relevant autonomous choices. Concurrent tests exposed duplicate introductions in the same recipient namespace.
4. Real-model qualification exposed a parent-city opportunity expansion and missed interior/exterior contact. The revision 2 Inspector record of `2f7b846e-a85e-41e6-9149-3020ddd2fdd8` also showed an NPC's chosen harbor observation rebound to its own inventory.
5. Follow-up corrections narrowed opportunity anchors, admitted adjacent contact candidates with semantic access checks, preserved interactions delivered during independent work, and removed the conflicting native inventory selector. Language publication retains all six factual checks with thinking disabled and a recorded inference override.

6. Third-cycle play in `51601adc-31dc-414d-8ab2-551f95a69838` created a nearby listener during the player's speech, but recipient enumeration only included pre-existing actors. The player had to repeat the question. Admission now batches new-actor perceptual access with its existing checks, and settlement installs admitted recipients before constructing observations and waking causal responses.
7. The same session completed payment but produced no fulfillment. Invocation `1750de7e-2ff2-4478-a148-4ccecf6d3166::rt:model-audit:75ce21f4845a204f296811b10f565c6858cad436e13510a54d71f291d34c37c8` selected physical use with a 0.47 optional-expression score. Revision 17 consequently submitted only a generic operation label to adjudication. Open physical actions now require a concrete method independently of optional manner, with missing methods rejected through the existing repair boundary.

## Root cause

An absent duration had been treated as a request for the smallest fixed profile. Scheduling prioritized the participant by excluding autonomous opportunities altogether. Positive prompt permission could not make missing candidates visible to adjudication, while independently selected scope fields could override an otherwise meaningful target. Per-settlement perception constructed identities independently even when multiple outcomes shared one atomic boundary. Recipient enumeration also ran before world expansion, so newly introduced actors could be narrated as present without hearing the event that introduced them.

Existing tests emphasized valid commits, cognitive isolation, literal dialogue and reply completion. Their scripted actors reacted only after contact; they did not qualify ordinary play across several real-model turns. Passing those invariants did not establish a coherent, responsive experience. The original publication model profile also allowed reasoning to consume the entire output budget for closed evidence comparison.

The physical-method path was mandatory for player requests but conditional on an optional expression vote for NPCs. This conflated the semantic method with decorative manner: an NPC could select useful work without expressing what to execute. A valid operation enum alone was insufficient evidence of an executable intent.

## Guardrails

- [Direct entry regressions](../../src/engine/direct/__tests__/runtime.test.ts) cover non-minimal timing, explicit waits, bounded locality, private context, adjacent perceptual access, duplicate introductions, independent activity with deferred replies, new-actor hearing and response, rejected creation, concrete NPC physical methods, bounded missing-method failure, and replay.
- [Persistent host tests](../../src/server/__tests__/direct-world-host.test.ts) retain causal foreground completion, background continuation and no model work during reads or restart.
- [Decision transport tests](../../src/engine/models/__tests__/decision-v2.test.ts) verify the language-only inference override and native fallback without extra inference.
- [Spec 0191](../specs/0191-natural-action-time-and-world-initiative.md) requires real-model trajectory qualification and latency/call-count evidence alongside structural checks. [Decision 0244](../decisions/0244-calibrated-time-and-local-initiative.md) records the bounded scope and rejected architectural alternatives.
