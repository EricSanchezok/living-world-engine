# System architecture

Living World Engine maintains one canonical world and multiple Agents with private cognition. Humans, models, scripts, and replay are policy sources for the same Agent abstraction; a Participant belongs to the product access layer, not to a second kind of simulation subject.

## Module boundaries

| Layer | Location | Responsibility |
|---|---|---|
| World contract | `src/script/` | Read schema v15 world packages, validate temporal/mechanics/resource profiles and assets, and construct `WorldDefinition` and `SimulationState` v17 |
| Execution algorithms | `src/engine/algorithms/` | Typed Roles, strict versioned definitions, recursive Compositions, generated discovery, and pinned producer resolution |
| Model gateway | `src/engine/models/` | Trusted provider accounts, models.dev snapshots, deterministic Profile resolution, protocol drivers, vendor dialects, external prompt bundles, strict structured output, fair scheduling, and invocation audit |
| Cognition | `src/engine/cognition/` | Agent perspective, private belief/character updates, observations, information boundaries, and mind commits |
| Mechanics | `src/engine/mechanics/` | Temporal, resolution, causality, random, interaction-dependency graphs, Truth Engine, rule packages, and shared-resource mechanics |
| Fixed runtime | `src/engine/runtime/` | Execution contract, SimulationEngine, CanonicalCommitter, transactions, lifecycle evidence, IDs, replay, and world runtime definitions |
| Program execution | `src/engine/programs/`, `src/engine/events/` | Private programs, native decisions, world rule compilation, event commits and default `decision-event@2` execution; see [runtime contract](game-design/world-program-runtime.md) |
| Prompt resources | `src/engine/prompts/` | Server-loaded English role/task/transport Markdown, content-addressed bundle versions, and unified task/context serialization |
| Shared contracts | `src/engine/contracts/` | Semantic state types, model-output schemas, and prompt/context contracts shared across owners |
| Benchmarks | `src/engine/benchmarks/` | Benchmark-only code and evidence generators kept off the product execution path |
| Instance host | `src/server/world-host.ts` | `WorldInstanceDocument` v24, immutable experiment enrollment, pinned recursive `AlgorithmRef`, persistent WorldRuns, Participants, decision/reaction windows, Preparation v5 artifacts, leases, recovery, and generation fencing |
| Execution evidence | `src/server/execution-ledger.ts` | The sole persisted source for executions, events, artifacts, experiments, replay, and Inspector data |
| HTTP and browser | `src/app/` | Public API v12, world library, assistant-ui sessions, decision/reaction controls, unified Agent Perspective HUD, control orb, and read-only Inspector API v13 with local Debug routes |
| Shared browser contracts | `src/shared/` | Browser-safe DTOs and trusted-local Inspector DTOs |

Dependencies flow browser → Route Handler → WorldHost → SimulationEngine → WorldExecutionAlgorithm → CanonicalCommitter. WorldHost resolves the complete instance-pinned Composition through the internal registry, and replay resolves the recorded tree through the same mechanism. Algorithms return candidates but never hold authority to mutate canonical state or define stable telemetry. The engine and world YAML load only on the server. [Algorithm system](game-design/algorithm-system.md) defines the replaceability boundary.

The benchmark-only [perception evidence reader](specs/0155-demand-read-perception-evidence.md) separates a complete immutable source from explicitly loaded wire records. Its read transcript and actual HTTP bodies account for the additional inference calls; the original gateway and canonical materializers retain full-source validation. Default perception continues to receive its complete context. The isolated [paired demonstrations](specs/0162-paired-perception-demonstration-screen.md) append authored cases to the system prompt while preserving the full source, output protocol and validators.

The benchmark-only [source-authored speech producer](specs/0163-source-authored-speech-screen.md) offers exact current utterances alongside unrestricted open actions. Its descriptor binds the speaker to the materialized actor and leaves delivery unadjudicated; the world runtime and cognition owners retain all authority.

The [sampled perception experiment](specs/0156-sampled-perception-candidate-selection.md) screens whole proposals before selection. TruthEngine and the experiment share pure onset-check materialization; randomness remains in the runtime after admission. A selected proposal retains its exact original fields and must still pass canonical validation.

The [fixed planning selection screen](specs/0173-fixed-planning-candidate-selection.md) binds three initial automatic proposals to their complete planning source. Its selection-only model returns an unchanged eligible proposal or abstains; the runtime plan materializer and original execution pipeline retain validation authority.

The [conditional perception report program](specs/0174-conditional-perception-report-programs.md) declares an initial check batch and conditional reports before runtime RNG. Its benchmark capability uses the shared check, RNG and receipt functions for local branch execution or explicitly defers to ordinary model interpretation; canonical commit validation remains unchanged.

The benchmark [temporal route representation](specs/0157-temporal-route-perception-screen.md) derives a terminal perception tag from a selected current or pending route case. Pending transfers have no stimulus payload; original receipt validation remains authoritative for the compiled result.

Its optional [observer-local symbol codec](specs/0158-observer-local-perception-symbols.md) binds existing claim identities to each assigned observer's complete local inventory. Explicit introductions remain model-authored; the codec restores selected opaque handles without identity inference.

The separate [source-frame screen](specs/0159-source-onset-frame-screen.md) tests one shared onset interpretation per assigned source action before observer projection. Frames remain diagnostic artifacts and never become canonical events or perception receipts.

The [action-phase graph screen](specs/0160-action-phase-graph-screen.md) exposes completion dependencies and external prerequisites between open attempted steps. Its initial frontier is a deterministic reading of an untrusted graph, with no execution or commit authority.

The [Agent intent-program screen](specs/0161-agent-intent-program-screen.md) generates control structure at the private decision boundary and preserves the complete program through a diagnostic action embedding. Its inspection exposes attempts or unevaluated conditions; production execution remains unchanged.

The [recursive intention experiment](specs/0164-recursive-intent-tree-screen.md) replaces model-authored graph references with embedded children and leaf-local targets. A deterministic compiler produces the complete indexed diagnostic representation without deciding which conditions or attempts succeed. Its separately registered player diagnostic passes the full intention through ordinary compilation and adjudication on the local plan repair foundation.

The separate [intention reference view](specs/0166-scope-qualified-intent-reference-screen.md) presents complete embedded intentions using action-local symbols and binding tables. Its benchmark planning adapter preserves the source and canonical output contract without interpreting intentions as execution.

The [initial intent frontier screen](specs/0170-initial-intent-frontier-screen.md) adds a deterministic starting view for assigned programs whose Activities are at the interval start. Complete intentions and temporal adjudication remain authoritative.

The experimental [incremental intent cursor](specs/0176-incremental-intent-execution.md) retains a residual program, issues uniquely bound attempts and advances from committed Activity evidence or owning-Agent guard decisions. The [persistent diagnostic](specs/0177-persistent-intent-execution.md) binds its journal to the producing Composition and saves it atomically with the world. Its gameplay semantics and latency require full-player qualification.

## State and policies

The model gateway also exposes the [native decision contract](game-design/model-gateway.md#协议方言与结构化结果) approved in [Spec 0181](specs/0181-jev-decision-event-engine.md). It keeps TypeSafe choice distributions and authorized input bindings in the existing scheduling and audit path, with an explicit generative context fallback. The [private program runtime](game-design/program-runtime.md) owns source-bound compilation, control-flow journals, separate goal evidence, dependency subscriptions and decision reuse. The [world program runtime](game-design/world-program-runtime.md) owns source-bound effect templates, condition evidence, read-set validation, atomic event commits and local scheduling. New World Instances use this decision-event execution path.

Action Compilation specializes [empty shared-resource domains](specs/0111-specialize-empty-resource-pool-domain.md) from its bound source state; representation adapters preserve that request schema through initial and repair calls.

The experimental `source-bound-observation-rendering@2` child projects a limited owner-bound progress packet for strictly admitted pending intervals; other observations retain model rendering. Its [admission contract](specs/0082-source-bound-pending-observations.md) defines state, timing, repair and verification boundaries. Both observation implementations preserve [current-event provenance](specs/0110-preserve-observation-event-provenance.md) separately from observer fact access. The default Composition does not select the experimental child.

The diagnostic [plan and transition co-generation](specs/0179-fuse-reviewed-plan-and-transition-generation.md) binds a provisional transition to complete, independently reviewed initial plans. Only unchanged first-pass plans with no check or additional randomness can reuse it. The original transition materializer, mechanics, causal review and commit retain authority.

The indexed reviewed Truth child can opt into [event-sourced outcome summaries](specs/0083-event-sourced-outcome-summaries.md). Its pinned `outcomeSummary` contract replaces independent outcome narration with explicit status and existing candidate event descriptions while preserving all other semantic output channels and commit checks.

`SimulationState` contains the sole `CanonicalWorldState`, Agents, admission commits, and semantic history. Canonical truth owns the world clock, durable Activities, Entity-backed shared-resource pools, WorldTimers, mechanics, and ordinary world facts. Every `AgentState` binds one active Entity and owns an independent `AgentBeliefState`, `AgentCharacterState`, epistemic bindings, observation cursor, and next action. The closed-loop state combines world state with all private Agent control state. `projectAgentPerspective` derives the same policy-independent, de-identified read model for AgentMind, reaction, grounding, Observation rendering, Arrival, Participant, and Observer without persisting another state.

`PolicyBinding` selects `model | external | idle | replay` for every Agent. External control does not create a PlayerState; the Agent's position, identity, history, and private observations remain unchanged. AgentMind does not run during external control and does not infer a human's beliefs, emotions, or next action. Release may move the Agent to idle or let AgentMind consume observations received during control before restoring model policy.

Models produce semantic drafts only. Agent, Entity, Fact, Meter, Rating, Condition, and subject-private cognition records use world semantic IDs. The engine deterministically assigns runtime identities for actions, Resolution Plans and Receipts, TemporalPlans, Activities, shared-resource pools, checks, random draws, mechanics, events, outcomes, observations, and apparent claims. It materializes revisions, steps, phases, lifecycle, progress, clock deltas, provenance, Profiles, and timestamps.

## Program and event execution

An Agent's private interpreter retains the position, conditions, subscriptions and receipts of reusable behavior. Jev evaluates concrete source-bound questions from the Agent's own perspective or the authorized world projection. DeepSeek generates a new program or exact utterance only when expansion is needed. The [program runtime](game-design/program-runtime.md) and [world event runtime](game-design/world-program-runtime.md) own these contracts.

WorldHost invokes the instance-pinned producer. Same-time control records update private planning; physical events select the earliest pending boundary and advance time positively. Connected actions share adjudication evidence. CanonicalCommitter re-derives mechanics, actual reads, effects, observations and private progress before committing atomically. Restored instances reuse their durable programs, bindings and receipts.

A failed model, validation or persistence operation leaves the committed world unchanged and retains its execution evidence. Unknown conditions and exhausted bounded repairs remain recoverable waits. The frozen legacy comparison and runtime qualification criteria belong to [Spec 0181](specs/0181-jev-decision-event-engine.md).

## World Instance and Participant

`WorldInstanceDocument` stores canonical state, its complete recursive `AlgorithmRef`, immutable experiment enrollment or exclusion, multiple Participants, every Agent's policy binding, one discriminated decision or reaction ActionWindow, runtime settings, scheduler state, persistent WorldRuns, Participant intents, reaction submissions, and execution references. The experiment registry assigns an eligible instance once through a domain-separated 10,000-bucket hash; each variant pins a complete Composition, and one experiment may be active in the world-execution layer. Explicit execution tuning is excluded from automatic enrollment. Changing an allocation, Algorithm, model, or salt requires another experiment version; restart and replay require the historical experiment manifest and reject drift. The generic registry validates every node's strict configuration, child Roles, identity, and recursive hash. Changing the host default affects only newly created instances; restart and recorded replay use the pinned Composition, while a missing or mismatched descendant fails before model work or state mutation. Product entry points allow one active Participant; the internal state and collection protocols support multiple Participants.

Manual Observer advance commits one temporal boundary; batch requests a boundary count; realtime only schedules wall-clock wakeups. A decision window includes external Agents at a decision point. A reaction window includes only the private stimulus for an external Agent whose ongoing intent can still respond. Window ID, stable generation, prepared-step ID, base revision, idempotent submission ID, and instance generation fence stale writes without serializing independent Participants' answers.

One Participant intent owns a persistent WorldRun that can commit multiple boundaries. Runs include `awaiting-reaction` and `preparation-invalidated` alongside the decision, execution, pause, completion, failure, and budget states. A reaction preparation finishes normally without a commit revision after its content-addressed artifact, frozen roster/request hashes, and window are atomically stored. Completion uses a child execution. Timeout applies the Activity profile fallback; restart does not rerun preparation, and a mismatch keeps canonical state unchanged until an explicit resume starts a fresh preparation.

Optional `participation.yaml` declares Origins and static images. An Origin fixes background, spawn point, an Entity Mechanics Profile, relationship hooks, risks, managed Profile, and fallback arrival text; the human supplies display name, appearance, and free-form motivation. A normal new game creates an Agent with its full Meter, Quantity, and Rating state from that profile. At a revision boundary, Observer may take control of any living idle Agent. Arrival Generator reads only that Agent's authorized private perspective and returns arrival narration plus three editable suggestions; it never produces world operations.

A Participant session projects persisted Arrival, Participant intent, every committed boundary Observation, world time, authorized Activity progress, and WorldRun state rather than storing a second message truth. Participant `controlledView` and Observer `selected.perspective` expose the same revision-scoped `AgentPerspectiveView`; changing `PolicyBinding` does not change its contents. During automatic execution the composer becomes a run console with pause/resume; after pause, an ordinary natural-language action may cancel or replace the Activity through semantic adjudication. WorldInspector uses a separate trusted-local projection with complete temporal and resolution evidence.

## World identity and persistence

Normalized world content receives a SHA-256 covering the manifest, laws, mechanics, entities, participation configuration, and static-asset identities. An instance pins its `WorldRuntimeContract` and world content hash, and reconstruction verifies both against the content-addressed version.

World versions, instances, and the Execution Ledger live in `LIVINGWORLD_DATA_ROOT/livingworld.sqlite`; content-addressed model-registry snapshots live beside it under `model-registry/`. The default v24 directory is `.livingworld-v24/`. Disposable local encoder assets and candidate vectors live separately under `LIVINGWORLD_CACHE_ROOT`, which defaults to `.livingworld-cache/`; a world content hash and encoder fingerprint partition the embedding SQLite files, and an exact passage hash addresses each checksummed Float32 vector. Operational entrypoints are grouped under `scripts/experiments/` and `scripts/operations/`, while repo-seed governance scripts retain their managed root paths. Canonical SQLite uses WAL, `synchronous=FULL`, strict tables, process leases, write transactions, and generation compare-and-swap. Old schemas are not migrated; a different contract uses a new data root.

## Hard invariants

- Action text expresses an attempt, never a state delta.
- Every Agent appears exactly once in the policy roster, and every final joint action has exactly one outcome.
- Every step contains exactly one engine-injected positive time advance equal to its earliest temporal boundary delta.
- Activity completion effects cannot precede completion; unrelated earlier boundaries do not move an Activity's absolute checkpoint.
- An Activity acquires all shared-resource claims or none; active holders, retaining pauses, and ready reservations never exceed the capacity of an active Entity pool, and queues cannot skip an unsatisfied connected head.
- Observation authorization and private text use observer-local IDs; only decision-eligible model Agents run AgentMind.
- Numeric writes are trusted-rule derived: Quantities use explicit provenance and conserve unless a world law authorizes production or consumption; Meter impacts clamp to script ranges; Ratings remain in script ranges.
- Every action pins one ResolutionPlan before resolution randomness, and every plan pins one deterministic ResolutionReceipt whose operations are part of the same atomic step.
- Placement is acyclic; an Agent binds an active Entity and owns one self binding.
- Causes and assertions for operations, mechanics, events, and outcomes resolve and hold before writes.
- External, idle, and occupied Agents do not run AgentMind; each eligible model Agent and Agent created in the step commits exactly one mind update.
- Ordinary world APIs never expose canonical truth, bindings, another Agent's cognition, model configuration, or internal error material. The local model-registry diagnostics defined by Spec 0007 expose only non-secret account status and resolved identities; they omit endpoints, dialect configuration, selectors, inference configuration, and credentials.
- Algorithms can emit only declared diagnostics; runtime event schema v4, stable lifecycle events, metric dimensions, aggregation semantics, and automatic Composition-node attribution remain engine-owned.

World package, runtime, algorithm, presentation, benchmark, and Ledger details live in [Script format](game-design/script-format.md), [Engine runtime](game-design/engine-runtime.md), [Algorithm system](game-design/algorithm-system.md), [Presentation](game-design/presentation.md), [Causal Activity benchmark](game-design/causal-activity-benchmark.md), and [Runtime observability](game-design/runtime-observability.md). Architectural rationale lives in [0061](decisions/0061-unified-agent-and-external-policy.md), [0063](decisions/0063-eager-reference-execution.md), [0064](decisions/0064-conversation-core-and-agent-perspective-observer.md), [0067](decisions/0067-open-semantic-resolution-plans.md), [0068](decisions/0068-unified-agent-perspective.md), [0070](decisions/0070-event-boundary-temporal-runtime.md), [0071](decisions/0071-pin-algorithms-and-own-telemetry-in-the-engine.md), [0073](decisions/0073-stage-reactions-before-temporal-boundary-selection.md), [0074](decisions/0074-enforce-script-owned-shared-resource-pools.md), [0075](decisions/0075-pin-configured-execution-algorithms.md), [0098](decisions/0098-content-addressed-embedding-cache-and-immutable-canary-enrollment.md), and [0099](decisions/0099-typed-hierarchical-algorithm-composition.md).

## Change procedure

1. Trace the current owners of the affected flow.
2. Obtain an Approved [Spec](specs/README.md) for a risk-boundary change.
3. Record a [decision](decisions/README.md) only when genuine alternatives exist.
4. Update this map and the owning product specification in the same change.
5. Run the governance gates and the smallest sufficient behavior evidence.

The optional [source-bound boundary clock](specs/0084-source-bound-boundary-clock.md) references trusted temporal input in outcome evidence while preserving actual causal validation.

[Activity progress and completion](specs/0109-align-activity-progress-and-completion.md) separates supported interval effects from whole-task settlement while preserving trusted interval receipt settlement.

The experimental [scoped plan repair batching](specs/0085-scoped-plan-repair-batching.md) option routes targeted semantic plan repairs through the shared Truth collector while retaining logical validation and replacement ownership.

The indexed reviewed planner can opt into [source-indexed plan causes](specs/0086-source-indexed-plan-causes.md). It selects existing causal evidence from the complete legal catalog domain; the codec restores exact kind/ref pairs while the original materializer checks action ownership and causal validity.

Its optional [action-local means indices](specs/0087-action-local-means-indices.md) bind each means source to an explicit position in that action's complete source inventory, preserving the original selector and grounding checks.

The opt-in [planning relation choices](specs/0114-bind-planning-relation-choices.md) bind explicit rating and effect choices to their source owners and compatible profiles, preserving full mechanical and semantic validation.

The optional [compact planning records](specs/0115-compact-planning-records.md) encode complete plans and repeated small records using schema-derived columns, retaining source content and canonical validation.

The indexed reviewed planner can opt into [shared planning catalog encoding](specs/0095-shared-planning-catalog-encoding.md) for plan, verification and continuation batches, preserving complete logical source contexts.

The same planner can select [plan-declared random completion](specs/0096-plan-declared-random-completion.md), binding an early termination decision to complete accepted initial plans while retaining result-dependent continuation.

Experiments account for [provider model cohorts](specs/0097-provider-model-cohort-accounting.md) through one append-only budget, immutable account/model prices and explicit routed-response reconciliation.

The model registry accepts [complete local model metadata](specs/0098-complete-local-model-metadata.md) for exact selection when the remote directory has not indexed a model, retaining local field provenance and execution snapshot binding.

The benchmark-only [repair reference witness screen](specs/0167-repair-reference-witness-screen.md) repeats exact candidate reference records and ownership joins after the singleton planning schema. Complete source contexts and canonical output authority remain unchanged.

The shared [bound-target dependency materializer](specs/0168-bound-target-dependency-reads.md) includes original target binding identities as conservative entity reads for compilation, grounding and conflict scheduling.

The benchmark-only [explicit compilation access sets](specs/0175-explicit-compilation-access-sets.md) rename the two dependency arrays on the wire and restore them before original validation. This representation neither infers dependencies nor changes the concurrency or commit contract.

The benchmark-only [canonical target planning screen](specs/0169-canonical-target-planning-screen.md) replaces plan and effect target indices with explicit entity references while retaining action, means, factor and cause constraints.

The separate [canonical cause planning screen](specs/0172-canonical-cause-planning-screen.md) changes only the outer cause reference field and its instructions. The complete cause table, slot permissions, other representations and original canonical validator remain authoritative.
