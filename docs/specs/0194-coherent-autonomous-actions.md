# Coherent autonomous actions and observer reading

Artifact-Version: 1
Status: Implemented

## Intent

Autonomous characters choose a coherent, motivated next attempt from their own knowledge. Observation, waiting, refusal and unfinished goals remain valid outcomes. Observer mode makes those attempts and admitted perceptions readable without adding narration inference or exposing another character's cognition.

## Contract

One language decision binds an NPC's operation, local target or listener, goal, concrete attempt and actual words together. It uses the actor's pinned creation profile and existing private memory projection. It replaces independent NPC parameter voting and the subsequent expression call; world adjudication retains its decision profile, schema checks, temporal authority and atomic commit. Repeated world question rules and action bodies are referenced from shared state without removing questions or evidence. Native preflight exhaustion uses the existing complete-batch context fallback after memory cannot make room; no rejected native HTTP call is needed. The batch, evidence and question count remain intact. The DeepSeek decision profile reserves 32,768 output tokens at low thinking effort, leaving room for structured answers after reasoning; ordinary calls still pay only actual usage. A bounded repair resolves invalid executed-branch bindings; exhausted repair is a recorded local failure, never a silently substituted wait. Player authority and literal dialogue remain unchanged.

Goal context includes retained goals, commitments, delivered interactions, recent attempts and actual receipts. A character can act on available opportunities without a player request, inspect a relevant uncertainty, or deliberately wait. No action quota, observation ban, forced goal selection or fabricated goal progress is permitted. Only received evidence supports cognitive goal completion.

Observer history shows the selected character's action and deduplicated admitted findings. Physical receipts report results without repeating the attempted method or copying internal capability descriptions into the conversation. Canonical IDs, hidden facts and private motives of other characters remain excluded. Internal evidence and replay stay available in the Ledger. Presentation adds no model calls. The algorithm producer advances to direct-world@8; incompatible local instances are preserved outside the active data root rather than migrated.

An unconfirmed speech channel remains explicit in the actor's receipt and observation; absence of delivery is not described as merely awaiting an answer. Preflight context rejection is recorded without starting a physical invocation and is reproduced by recorded replay and debug checkpoint recovery.

Independent adjudication components retain parallel execution and own deterministic invocation namespaces derived from their action IDs. Repair and expansion identities must not depend on which other component's HTTP response finishes first.

## Plan

Share the language reading boundary and executed-branch validation, remove the independent NPC expression path, clarify autonomous goal use, and clean observation construction and observer presentation. Qualify through deterministic engine/host entry paths and a fresh live observer run.

## Verification

Cover speech/listener coherence, meaningful physical methods, legal waiting and repeated purposeful observation, goal continuity without invented completion, cognitive isolation, bounded repair, durable replay, observer deduplication and responsive controls. Run check:fast and check:ui. Compare live committed actions, dialogue delivery, goal evidence, calls, tokens and latency against the recorded ten-boundary baseline; action diversity alone is not success.

## Evidence

The baseline instance `0cf391ab-e8ee-41a6-b085-d87433c3ed4d` records 75 completed actions across ten boundaries: 65 observations, six reflections, two speech actions and two physical operations. The 268 model calls include 34 initial speech selections, 31 without a listener. Archon Devers's contradictory speech selection is invocation `d1f69d5b-32eb-439a-8666-117e376d71db::rt:model-audit:81d1fb7bff51d2e38b312a8e8a71a57ac0e96e3a3ef0b6765bc793a050df1836`; the recipient-only follow-up selects none and execution returns to waiting. These are observed failures, not required action-frequency targets.

The live observer instance `7ca939c9-3e4e-481f-84df-cfde4cd02003` ran two batches of ten global boundaries with 47 initial Agents and three subsequently admitted characters. At world time 181 seconds, 125 completed actions comprised 69 speech, 43 observation, seven use, five movement and one reflection. Forty speech actions have another character's actual received observation. Every bound speech has words and a listener or broadcast channel; speech without an admitted listener does not become a delivered interaction. There were no failed Agent intents. The final feedback correction makes non-delivery explicit instead of presenting it as an unanswered question.

Goal continuity is visible in both dialogue and state: Devers requested spending and force-accountability records, Travvarn later accepted and specified the procedure, and Devers inspected readiness before drafting the ledger page. Step 19 committed `create_entity` for that page into Devers's possession. The broad mission goals remain active; requesting or accepting a procedure did not falsely finish them. Other characters moved, inspected objects and attempted physical work. This is evidence of coherent attempts and local consequences, not proof that every autonomous plan is useful or every long-term goal will finish.

| Measure | Baseline, 10 boundaries | Joint reading, first 10 boundaries | Joint reading, 20 boundaries |
| --- | ---: | ---: | ---: |
| Completed actions | 75 | 82 | 125 |
| Observations | 65 | 27 | 43 |
| Speech actions | 2 | 50 | 69 |
| Actual model starts | 268 | 261 | 328 |
| Provider-reported input tokens | 4,618,872 | 3,999,676 | 5,222,711 |
| Provider-reported output tokens | 278,100 | 226,137 | 287,200 |
| Reported reasoning tokens (included in output) | 16,178 | 78,798 | 92,474 |

The trajectories differ, so these counts are qualification data, not an equal-work speed benchmark. The first new batch took 436 seconds and the second 261 seconds; broad world adjudication and language reasoning remain a latency limitation. The two large-context fallback calls in the first batch completed with the 32,768-token output budget; the earlier 8,192-token profile exhausted its entire output on reasoning and returned no JSON.

Recorded execution `c0b18b51-6053-4879-9a35-6da16e879b54` replayed with matching semantic and state hashes and no network access. A deterministic persistent-host regression separately forces preflight fallback, checks exact candidate replay and checkpoint recovery, and verifies that neither path calls the model again. Physical-world replay and perception isolation are also covered through the engine entry point.

Three further live boundaries reached world time 211 seconds with 133 completed actions and no failed Agent intents. Browser inspection exposed internal capability wording in physical receipts; the result-only receipt regression covers that final presentation correction while preserving the full executed method in the Ledger.

A fresh eight-boundary run (`2804a351-fa00-4d57-93a8-4877ab9cfafc`) reached 90 seconds with 93 completed attempts: 51 speech, 31 observation, seven movement, two reflection and two physical operations; twelve speech actions had actual recipients. All 47 Agents retained active goals and no failed intent. The trace contains 243 model starts, 3,709,974 input tokens and 213,619 output tokens, including 52,337 reasoning tokens. Its first-boundary algorithm replay exposed the shared world invocation counter's sensitivity to HTTP completion order. Component-owned namespaces replace that counter sharing; a persistent-host regression deliberately reverses completion order and requires identical semantic/state hashes with no live replay calls.

Final qualification instance `f711f140-a52a-42a6-a694-cd203bb2e9ef` ran four fresh boundaries after that identity fix, reaching 60 seconds with 64 completed attempts: 34 speech, 24 observation, two movement, two reflection and two physical operations. There were no failed Agent intents and full-state replay matched. Its first execution `4a760d71-6a58-48a7-aa7b-b9398f73aa3c` also replayed through the algorithm with exact semantic and state hashes and no network access. One recorded native preflight context rejection used the configured complete-request fallback successfully; the Ledger doctor reports fresh indexes with no missing rows, orphaned rows or artifacts.

Permanent regression evidence lives in the [runtime tests](../../src/engine/direct/__tests__/runtime.test.ts), [persistent-host tests](../../src/server/__tests__/direct-world-host.test.ts), and [observer browser flows](../../e2e/flows/immersive-game.spec.ts). Final checks passed: `check:fast` (365 test files, 2,437 tests), `check:ui` (16 browser flows and four accessibility tests), and bundled-world validation. The local observer instance is retained for interactive inspection; earlier incompatible and qualification saves are preserved in ignored backups outside the active data root.
