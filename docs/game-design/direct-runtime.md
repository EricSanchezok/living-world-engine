# Direct world runtime

This reference owns the default `direct-world@1` execution contract, approved in [Spec 0182](../specs/0182-jev-direct-world-runtime.md). Its implementation lives in [`src/engine/direct/`](../../src/engine/direct/algorithm.ts). The script contract is v16, SimulationState is v18 and WorldInstanceDocument is v25.

## Model responsibilities

`DecisionBatchV2` binds one authorized perspective, concrete dependencies, question versions and the pinned model configuration. Choice selects typed actions and parameters, Noul evaluates a concrete relevance question, and Score orders urgency. Independent questions share a request. Answers for unused branches have no effects. Native probabilities and score legends remain diagnostic evidence; they never become game randomness. Actual provider context rejection can split independent questions, then use the configured creation-capable decision fallback for an irreducible question. UTF-8 byte estimates do not establish native context rejection.

Jev selects movement, observation, speech, transfer, use, changes and waits. Code builds ActionFrames from existing local identities, resource definitions, literal quantities, quotations and learned capabilities. Unknown requests further observation, clarification or waiting. A compound player request keeps its original submission until the next authorized step is handled or it reaches a genuine wait. Input completion, an immediate action result and long-term goal completion are separate records.

Ordinary speech acts can compose exact words from selected resources, quantities and existing beliefs. DeepSeek generates new literal dialogue when these expressions are insufficient. A capability extension is a concise qualitative effect declaration with applicability, existing condition profiles or a constructed object. Code supplies references and execution structure. One targeted structural repair is allowed. Capability knowledge propagates to actual observers of its use; private memories and plans are not a global library.

World adjudication receives local entities, placement, relevant facts, resources, effects and explicit laws. Script rules take precedence. Uncovered ordinary behavior permits common-sense adjudication. The decision binds immediate outcome, duration, material consumption or production under an authorized law, qualitative fact effects, numeric impact profiles, condition effects, shared capacity and actual perception. Sources provide traceability; ordinary effects do not require a pre-authored rule proof.

## Persistent activities and the timeline

Bootstrap saves the world and every Agent's initial intention without model inference. Initial NPC decisions are durable ready tasks and execute when the host advances the world. A submitted player action gets priority over unrelated initial work; received observations and deadlines wake relevant NPCs.

Intention state retains the current goal, an active submission, wake causes, owned dependency hashes, activity identity, waits, progress evidence, recent receipts and recoverable failure. Observations append actual events or delivered testimony directly to private evidence. Existing claims and goal progress are evaluated with the next relevant action decision. Testimony does not itself become a canonical fact.

Adjudication is saved as prepared effects. Finite activities retain their absolute due time through earlier world timers. Continuous activities retain their active lease and elapsed progress without asking a model at every checkpoint. Shared resource claims are allocated together in stable admission order; queueing postpones the start until capacity is available. Interruption removes the superseded pending effects. Changed actual dependencies invalidate the affected preparation.

The earliest activity, timer, condition expiry, recurring effect or explicit wait deadline is a barrier on the canonical timeline. Control-only records may keep the same world time. Physical commits advance by a positive number of seconds. A repeated input or repeated action without meaningful progress enters a recoverable wait. One failed model task retains its failure locally while independent admitted work and clock events can continue.

## Mechanical commit and replay

Code computes references, quantities, clamped numeric changes, resource conservation, time and IDs. A shortage becomes a blocked local result with no partial debit. The canonical transaction checks actual read hashes, ordered due events, producer identity, owned random commitments and replay identity, then saves the whole event atomically.

Random distribution and effect bindings are persisted in a control commit before a draw. Settlement consumes that commitment using the seeded stream. The committed event retains requests, results and RNG state. Replay applies recorded semantics and checks deterministic mechanical consistency without a provider call or a new semantic choice.

The trusted Inspector exposes intentions, actions, saved activities, wake reasons, local failures, typed decisions, dependencies, capability declarations, model usage and cost provenance. Normal participant views retain private cognitive isolation. WorldHost, the Execution Ledger, generation fencing and instance transactions remain the persistence boundary.

## Qualification

The direct runtime and the all-DeepSeek decision variant share the same execution code. [The qualification contract](../specs/0182-jev-direct-world-runtime.md#verification) owns outcomes, comparison arms and the cumulative paid budget. Deterministic transport replacement proves owned mechanics and persistence; it does not establish real model success rates or cost and latency gains.

For real browser qualification, start the workbench with `LIVINGWORLD_JEV_BUDGET_ROOT=.livingworld-benchmarks/jev-engine`. Its provider transport shares the CLI experiment ledger, retained unknown reservations and CNY 100 cumulative ceiling. Only the priced Jev and DeepSeek accounts are admitted in this mode. One live writer owns the ledger; stop the workbench before starting another paid qualification process. Ordinary startup without this option uses the configured provider transport.

The generated-program engine is available in [frozen source](https://github.com/EricSanchezok/living-world-engine/tree/05d273f7/src/engine/events). Its failed trials remain historical evidence. Explicitly registered reference and benchmark algorithms remain research infrastructure; new instances use the direct runtime.
