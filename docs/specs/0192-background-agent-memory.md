# Background Agent memory compaction

Artifact-Version: 1
Status: Approved

## Intent

Support sustained play through incremental, subject-private memory compaction. The user approved an 80% background trigger, preservation of important people and events, concurrent append safety, existing infrastructure reuse, no retrieval system and forward-only implementation.

## Contract

- Measure complete model requests against the pinned model input capacity, output reservation and any per-question limit. Token estimates are labeled estimates and calibrated against observed usage. Profile limits may lower capacity for reproducible qualification. Start background compaction at 80%; never require a fixed resulting ratio.
- One Agent memory reader supplies recent evidence, a chronological summary and protected source-linked records. Canonical facts, identity, current character state, goals and commitments retain their owners. Immutable raw evidence remains available for validation, trusted inspection and replay; it is not a second model-input path.
- Compact only a frozen prefix of the owner's delivered evidence and beliefs. Preserve recent evidence verbatim. Protected records survive successive summaries unchanged. Changed claims and evidence appended during generation remain visible after publication, including records carrying an earlier step number.
- Background work uses the owner's bound creation Profile, the existing gateway and Ledger, one worker per Agent and bounded background concurrency. Ordinary turns make no compaction call below the threshold. A request that cannot fit waits for useful in-flight compaction and rebuilds its context; failure or insufficient reduction produces an explicit capacity error, never silent truncation or an infinite retry loop.
- Instance checkpoints use source hashes and memory versions, independent of world revision. Publication atomically merges with the latest instance. A memory update does not advance world time, revision or cognition. Completed checkpoints survive restart; unfinished work is eligible only after fresh demand. No read or refresh starts inference.
- Increment the instance contract and the Direct producer, preserving the preceding data directory without migrations or compatibility producers. Public game views retain their contracts.

## Plan

Implement the subject-private reader and compactor; connect request pressure and background persistence; exercise concurrency, grounding, restart and actual Direct calls; qualify multiple successive compactions with real models.

## Verification

Cover threshold boundaries, complete/native request sizing, source isolation, stale results, concurrent append and changed claims, immutable important records across at least three compactions, failure, restart, foreground rebuilding and no-progress rejection. Run focused tests, check:fast and real-model play, recording recall correctness separately from model self-report and token/latency evidence.

## Evidence

Deterministic coverage uses the real WorldHost, gateway, scheduler, instance CAS and recorded replay. It verifies the 0.799/0.8 boundary, one in-flight task per subject, foreground priority, concurrent observations, changed claims, stale-result rejection, interrupted-task recovery without inference, capacity rebuilding without ghost invocations, and monotonic calibration under out-of-order provider responses. Three successive checkpoint generations preserve protected original records and exclude another Agent's private evidence.

Real-model qualification on 2026-10-17 used the production Jev and DeepSeek profiles without capacity overrides. A 12-turn game completed 11 successful compactions, including 10 whose publication followed newer world revisions. After nine intervening ordinary conversations, the NPC correctly recalled the helper and rescue, 17 stones, the three-day/evening/Stone Gate agreement, the original code, and the later blue scarf and separate code. World replay passed after every turn; the final recorded execution replay succeeded. The authored prehistory accelerates compression; this is successive-compaction evidence, not a thousand-turn retention claim. A separate seven-turn production run completed six compactions and the same recall checks; a tighter per-question stress run completed ten compactions.

The 12-turn run's measured turn latency was 9.3–16.7 seconds, with a 13.2-second median. Its eleven compactions used one creation call each; input/output token counts, original utterances, memory versions, source records and execution IDs are recorded by the [qualification harness](../../scripts/operations/memory-playtest.ts). The harness keeps the nine-turn recall gap and uses the existing Ledger. An earlier no-reduction candidate was rejected without replacing memory or stopping play.

`check:fast` passed 365 test files and 2,427 tests, TypeScript, prompt and algorithm verification, world validation, debug/workflow contracts and all six governance gates. ESLint reported only three existing unused-variable warnings. The final qualification Ledger passed `debug:doctor` with 38 executions, 1,912 indexed events, no issues, missing rows, orphan artifacts or warnings. The restarted workbench returned HTTP 200 for `/`, `/api/worlds` and `/api/instances`, with Blackmarsh available in the fresh v32 data root and the preceding v31 directory preserved.
