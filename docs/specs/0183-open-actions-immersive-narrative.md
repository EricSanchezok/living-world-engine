# Open actions and immersive narrative

Artifact-Version: 1
Status: Approved

## Intent

Preserve event-driven world execution while replacing fixed dialogue and raw observation prose with open character expression, persistent world expansion and adaptive participant narration. The human approved this contract in the explicit implementation request on 2026-10-13. The frozen comparison is commit `e539f52f`.

## Contract

- Players propose arbitrary attempts; established world facts and consequences retain authority. Jev selects and adjudicates; DeepSeek creates concrete expression, missing concepts and player prose. There is no Jev request-share gate for this work.
- Actual utterances exist before delivery. An ActionExpression separates requested action, literal words and observable manner. NPC creation uses only its owner's perspective, character and memory. Continuations and irrelevant wakes do not generate new content.
- With creation enabled, the pinned DeepSeek decision profile interprets arbitrary player language into the same typed action contract. Jev retains autonomous decisions and world adjudication. Participant interpretation is measured as its own normal route, not classified as context fallback. Narration receives executed observations rather than the original request's unperformed future steps.
- WorldExpansionDrafts may introduce entities, characters, facts, local events and reusable capabilities. Code assigns identities and execution structure; one local semantic judgment and mechanical transaction checks admit effects. New actors receive private cognition, goals and scheduling. Introductions never rewrite established history or mint conserved resources without an authorized mechanism.
- Public appearance and environmental detail are distinct from secret identity and motives. Player ScenePackets contain only authorized observations, known entities, delivered speech and relevant prior scenes. New interactive content enters world state before narration.
- NarrativeBeats are durable, ordered projections of frozen event sources, not a second world truth. Text varies in length with the situation. Code inserts delivered utterances by reference. Narration cannot choose player actions or feelings, convert testimony into truth, or invent completed outcomes.
- World persistence atomically records pending narration. Workers publish complete immutable segments; GET and SSE reconnect only read. One participant's beats are generated in order, coalescing newly visible events. A generation failure gets at most one continuation attempt, then a factual fallback, without replaying world effects.
- Participant decision deadlines begin when their actionable feedback is ready. Narrative generation never spends the player's reply window. World time remains independent of model wall time.
- Contracts become world v17, state v19, instance v26 and public API v14. Archived saves remain in their old root; no migration or runtime compatibility branch is introduced.
- Default models remain jev-1.13.0 and deepseek-flash with thinking disabled, pinned with prompts. Existing audit, usage and request evidence includes streaming, failure and repair work.

## Plan

1. Upgrade contracts and implement concrete character expression and perceptible details.
2. Add scene projection, durable narration outbox, streamed paragraph persistence and participant presentation.
3. Extend world creation and new-actor admission through existing canonical mechanisms.
4. Verify real entry paths, replay, isolation and immersive continuous play, then publish the default local experience.

## Verification

- Deterministic regressions cover action-versus-quote interpretation, NPC individuality, delivered speech, perceptible details, hidden facts, testimony, partial/failing actions, idempotent expansion, new actors and learned capability reuse.
- Host/UI regressions cover paragraph order, reload, disconnect, restart, local failure, atomic outbox, deadline deferral and separate presentation metadata.
- Run check:fast and relevant browser checks before committing each verified unit.
- Add a separately capped CNY 100 tranche to the existing append-only ledger; retain historical charges and unknown holds. Initial development probes cost at most CNY 10. Stop early on successful qualification.
- Live work includes eight development flows, twelve unseen confirmation flows of 3–6 turns, and one >=10-turn continuous session in each of Blackmarsh and the station, including full 49-subject admission. Freeze inputs/configuration before confirmation; preserve failures.
- Report first useful paragraph and complete actionable feedback separately. Targets: P80 <=30 s, P95 <=60 s, with no artificial delay or semantic cutoff. Assess intent fit, character consistency, concrete imagery, continuity and adaptive detail; >=90% qualifying confirmation turns is a target, not an unmeasured claim.

## Evidence

Deterministic persistence, streaming, exact speech, expansion and restart evidence is in the [host tests](../../src/server/__tests__/direct-world-host.test.ts), [narrative tests](../../src/server/__tests__/world-narrative.test.ts), [direct runtime tests](../../src/engine/direct/__tests__/runtime.test.ts) and [stream accounting tests](../../src/engine/models/__tests__/response-stream.test.ts). Live quality and performance qualification remain separate from these checks. Historical baseline: [direct runtime evidence](../research/2026-10-13-jev-direct-world-runtime.md).

Live qualification, retained failures, full transcripts and browser evidence are recorded in the [Chinese research report](../research/2026-10-14-immersive-narrative-qualification.md). The frozen final cohort qualifies 25 of 37 attempts; the 90% experience target is not met. Deterministic checks and state replay do not supersede that result.
