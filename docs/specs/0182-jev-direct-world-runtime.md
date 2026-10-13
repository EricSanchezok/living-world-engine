# Jev Direct World Runtime

Artifact-Version: 1
Status: Approved

## Intent

Replace the mandatory generated-program execution loop with direct typed decisions, actions and committed events. The user explicitly approved implementation of this contract on 2026-10-13. Ordinary behavior may use common-sense adjudication when the script contains no explicit rule. The previous engine remains available from frozen Git revisions, not as a second maintained runtime.

## Contract

### Decisions and actions

DecisionBatchV2 supports native Choice, Noul and Score questions, including structured instructions and criteria. Each batch binds one authorized view, actual dependencies, question versions and model configuration; program identity is not required. Independent questions share a request. Answers from an unselected branch have no effect. Unknown is an explicit result and ordinarily produces observation, inquiry or a relevant wait. Probabilities are diagnostic; ordinal scores are not physical quantities or random draws.

Code constructs ActionFrames from typed selections over entities, locations, resources, relationships, capabilities and spans from player input. The action vocabulary covers movement, observation, communication, transfer, use, state changes and waiting. New combinations and plausible uses may be adjudicated directly. Missing concepts or capabilities may be created through concise declarations and reused by other eligible actors. Free text, complex new strategies and capability extensions use DeepSeek only when needed. Speech establishing testimony, commands or commitments exists before execution and affects recipients only after delivery.

AgentIntentState persists goals, commitments, relevant observations, activity progress, waits and recent receipts. No complete generated plan is required to start or act. Goal completion, partial progress and activity completion remain separate. Agent decisions receive only their private cognitive view; local world adjudication receives the necessary authorized truth. Full audit data remains available in the trusted Inspector.

### Adjudication and commit

Jev decides feasibility, applicable explicit rules, common-sense outcomes, effect categories, degree and observability once. Code derives operations, read/write sets, arithmetic, timing and identifiers. Sources provide traceability; an ordinary action does not require a pre-authored proof for each effect. Semantic disagreements do not initiate serial reviewers or complete program rewrites. Noncritical explanations and minor probability rounding discrepancies are diagnostics.

The transaction kernel blocks invalid references or numbers, resource imbalance, stale actual reads, invalid time ordering, duplicate effects and broken atomicity. Random outcomes are durably committed and replayed. Model confidence does not bypass these properties. Normal actions use authored time profiles or reasonable world time defaults; players need not state a duration. Resource contention yields a local action result. Replay applies committed events without model calls or fresh semantic adjudication.

### Startup, scheduling and failure

Save and expose the initial world without waiting for NPC inference. NPC first decisions are durable tasks. Relevant observations, changed dependencies, activity deadlines and world timers wake local work. Continuous activity and waits do not repeatedly call a model. Repeated identical input without progress becomes a recoverable local state. One failed model task does not invalidate the instance or unrelated committed work.

One ordered timeline settles admitted due activities. Model computation cannot commit an action into the past; its dependencies must remain valid when admitted. Context contains actual required dependencies. Byte estimates never declare native Jev unavailable. Actual provider context rejection may split independent questions; irreducible overflow uses an explicitly accounted decision fallback. No evidence is silently truncated to force a request through.

### Product and persistence

Pin `jev-1.13.0` for decisions and `deepseek-flash` with thinking disabled for creation. Preserve the all-DeepSeek decision variant for controlled comparison within the same architecture. Upgrade world/state/instance contracts to v16/v18/v25. Archive old instances and create new ones without migration or silent producer changes. The default runtime uses the direct action loop. Inspector exposes intentions, actions, wake reasons, local failures, decisions, creation reasons and full cost provenance.

## Plan

Implement the native decision contract, then a complete creation-to-player-action-to-NPC-response-to-restart path. Connect full-world goals, activities, memory, local scheduling and reusable creation. Replace the generated-program chain, update defaults and Inspector, and record independently checked local commits.

## Verification

Use real WorldHost/API entry points and persisted state; replace only model transport in deterministic tests. Cover ordinary movement, observation, transfer and authored abilities with creation disabled; multi-turn negotiation and delivery; unanticipated tool use; reusable extensions; deception, unknown, partial completion and waiting; local request failure; hidden cognition; concurrent resources, deadlines and fixed randomness; restart and replay without duplicate effects. Include full 49-subject Blackmarsh and station repair/resource exchange.

Retain frozen A, new architecture B with DeepSeek decisions, and new architecture C with Jev decisions. Freeze tasks, model configurations and outcome criteria before paid trials. Count all generation, repair, fallback and failed requests, total calls and calls per useful progress. Targets: Jev at least 80% of runtime physical requests, DeepSeek calls reduced at least 80%, cost per successful task reduced at least 70%, median useful-feedback latency reduced at least 50%, P95 no worse, independent task completion at least 90% and no worse than A. Failed/censored baselines cannot establish speedup ratios.

All paid work shares the existing CNY 100 cumulative cap, including known use and full unresolved reservations (approximately CNY 81.06 already exposed). Never reset the ledger or treat unknown usage as zero. Insufficient budget leaves remaining qualification explicitly unverified. Relevant checks and `npm run check:fast` precede each local unit commit.

## Evidence

The default implementation is described in the [direct runtime reference](../game-design/direct-runtime.md). Deterministic coverage exercises [persistent WorldHost entry and restart](../../src/server/__tests__/direct-world-host.test.ts), [direct actions and local failure](../../src/engine/direct/__tests__/runtime.test.ts), and [activities, materials, shared capacity, capability reuse and committed randomness](../../src/engine/direct/__tests__/activities.test.ts). These tests replace only model transport; they do not qualify model semantics or performance.

Paid qualification remains pending. [Decision 0228](../decisions/0228-jev-direct-world-runtime.md) records the alternatives. [Prior qualification](../research/2026-10-13-jev-engine-qualification.md) owns historical failures and budget provenance; those measurements do not qualify this replacement.
