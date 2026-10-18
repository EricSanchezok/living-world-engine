# Relevant NPC wakes and bounded model cost

Artifact-Version: 1
Status: Approved

## Intent

Implement the user's approved cost reduction on merged main without reducing natural action freedom, independent goals, cognitive isolation or the full Fanren world. Preserve one execution path for participants and observers. Separate receiving information from deciding to act on it.

## Contract

- Perception still records every delivered observation. In the existing world decision batch, a closed relevance question may defer a passive witness's reconsideration only when the event is clearly incidental to its current concerns. Uncertainty remains eligible. Direct recipients, public calls, action targets, active work, explicit timers and deadlines retain their existing eligibility.
- Relevance uses the event and the recipient's own goals, commitments and current work, inside the trusted world adjudicator. It does not expose private concerns to other Agents or grant new knowledge. No additional model call or mandatory model gate precedes an NPC decision.
- Decision reuse ignores elapsed-clock-only changes. New outcomes, causes, knowledge, goals and explicit temporal wakes still permit decisions. Refresh dependency hashes when an identical input is skipped. Never cache an actor's action across different actors.
- Preserve single joint natural-language interpretation and argument binding. Typesafe continues closed adjudication; creative intent and dialogue retain DeepSeek. Do not ban observation, require arbitrary activity or disable offscreen Agents.
- All live DeepSeek defaults and experiment requests use deepseek-flash. Ordinary generation disables thinking; explicitly justified reasoning uses low. Historical evidence remains immutable. Persisted producer/configuration changes require fresh instances; keep old data roots untouched.

## Plan

Land wake scheduling and decision reuse as one checked unit, then model routing and inference controls as a second. Keep existing perception, interpretation, publication and persistence boundaries. Validate each unit before committing it, then retain bounded live comparison evidence and push main.

## Verification

Exercise delivered-but-incidental observations, relevant opportunities, direct speech, clock-only changes, timer wakes, continued tasks and deterministic replay through real engine entry points with only external model transport replaced. Compare a bounded fresh full-world Fanren trial before and after using identical seed and participant actions, reporting actual calls, input/output/reasoning tokens, failures and gameplay limitations. Run focused checks and check:fast for each independently verifiable unit; commit each unit and synchronize main only after checks pass.

## Evidence

The [Direct entry-point regressions](../../src/engine/direct/__tests__/runtime.test.ts) cover passive memory retention, relevant wakes, direct calls, clock reuse and explicit temporal wakes. The [scheduling decision](../decisions/0268-event-relevance-without-an-extra-npc-gate.md) records why observation mode does not control intelligence. Model configuration and live comparison evidence follow in the second implementation unit.
