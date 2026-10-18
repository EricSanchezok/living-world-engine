# Conversational continuity and recoverable interaction

Artifact-Version: 1
Status: Approved

## Intent

Make continuous play understandable through shared conversational context, grounded character introductions, natural clarification and explicit recovery. The human authorized this scope, a separate CNY 100 ceiling, maintained private work notes and local commits on 2026-10-14. Freeze a reasonable continuous evaluation suite before implementation. Completion requires measured qualification of at least 90%; failed experiments remain evidence.

## Contract

- Participant discourse is a durable projection of what that participant has actually been shown. It records local entity references, introduced descriptions, speakers, recent exchanges and unresolved requests. It is separate from canonical truth and Agent belief. Arrival and published paragraphs are part of the same presentation history.
- Input interpretation and narration consume the same authorized discourse references. A newly encountered person receives an intelligible introduction; later references preserve that person's identity. Hearing a voice does not establish appearance or secret identity. Generated prose cannot create a canonical binding or grant an Agent knowledge.
- Distinguish a request to clarify the presented scene, speech directed at a character and a physical attempt. Interpret ellipsis, corrections, conditional consent and compound requests in context. Record requested, attempted, completed and pending components separately. Clarification that only explains existing perception does not advance world time or become delivered speech.
- NPC responses use the recipient's actual observations and private cognition. A question can be answered, refused, misunderstood, deferred or left unresolved for a grounded reason. Ordinary conversation must not require a transaction or an invented condition to proceed.
- Semantic failure and partial progress are narratable outcomes. When model service is available, DeepSeek explains the established result, available evidence and unresolved part naturally without inventing diagnoses or choosing the player's next action. Known-responder processing status with no new observation or speech uses the narrower direct presentation contract in [Spec 0206](0206-direct-known-response-failure-feedback.md). Infrastructure failures retain typed causes. Budget/request caps use clear deterministic status text and stop automatic retries; transient failures permit bounded local recovery.
- Interactive execution has an explicit bounded temporal horizon. A reply-window expiry does not authorize jumps to unrelated distant deadlines. Pending feedback and service failure cannot consume the player's reply time. Existing committed outcomes remain durable; later work cannot replay their effects. Explicit waiting and observer simulation retain their chosen horizons.
- Budget grants are append-only, retain historical usage and unknown holds, and carry explicit bounded request capacity. A new grant never silently resets counters or broadens its currency ceiling. The additional authorization for this work is CNY 100, shared by tests and browser use.
- Runtime, save and API contract changes use new versions and a new data root. Preserve old evidence and saves for inspection; do not add migration or dual execution paths.

## Plan

1. Freeze the [evaluation protocol](../research/2026-10-14-conversation-continuity-protocol.md) and executable scenario corpus before changing runtime behavior.
2. Establish auditable request capacity, typed recovery status and temporal regressions.
3. Connect durable discourse, private perception, input interpretation and narrative generation; replace redundant heuristics and templates in the affected path.
4. Exercise deterministic entry-path, persistence and UI checks, then real development, confirmation and continuous sessions. Record every trial, including failures and missing rounds.

## Verification

The [scenario corpus](../../src/engine/benchmarks/conversation-continuity/cases.ts) owns frozen input and intent checks. Qualification rules and the denominator are defined in the evaluation protocol. Confirm the full Blackmarsh roster and the station through WorldHost, committed state, delivered observations and persisted paragraphs. Check cognitive isolation, conservation, replay, duplicate submission, service failure and idle time separately from prose quality. Freeze code, world, prompt, model and rubric hashes for each confirmation run; never exclude a difficult case after seeing its result.

## Evidence

The baseline [qualification report](../research/2026-10-14-immersive-narrative-qualification.md) records 25/37 qualifying turns. It does not qualify this contract. This spec's live acceptance remains unverified until a complete report links all frozen cases, state checks and full transcripts.
