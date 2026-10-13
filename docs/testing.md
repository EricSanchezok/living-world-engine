# Testing policy

Tests are executable evidence that a meaningful regression becomes visible before delivery. Name the invariant at risk, then choose the lowest boundary that can observe it with production-like composition. Optimize for durable signal, not test count or coverage percentage.

## Test topology

- Vitest tests are colocated as `src/**/__tests__/*.test.ts`, `src/**/*.test.tsx`, and focused library tests under `src/app/_lib/__tests__/`; `vitest.config.ts` selects the unit project and `test/setup.ts` owns shared jsdom setup.
- `test/fixtures/open-world-script/` is the shared schema v16 world fixture. It proves the generic contract and is not built-in playable content.
- Playwright flows live under `e2e/flows/`, accessibility coverage under `e2e/a11y/`, shared support under `e2e/support/`, and platform-specific visual baselines beside the owning visual flow. `playwright.config.ts` selects the e2e and a11y projects.
- `worlds/blackmarsh/` is the real reference-world entry used for structural and live compatibility checks.

Repository-wide commands live in [AGENTS.md](../AGENTS.md). `npm run check:fast` owns lint, types, Vitest, the world fixture, workflow verification, and governance gates. `npm run check:ui` owns production E2E and accessibility. `npm run check:all` composes both. `npm run test:live:qwen`, `npm run test:live:glm`, and `npm run test:live:deepseek` are manual compatibility checks using process credentials and are not deterministic CI gates; the Qwen command is the default local live smoke profile.

Visual snapshots keep separate operating-system baselines with the same strict pixel threshold. Eliminate cross-platform geometry differences first; platform baselines absorb only irreducible font rasterization and rendering differences.

## Evidence rules

- Verify the world, not model self-report. Assert committed truth, belief, RNG, files, public events, or an authorized role view; narrative claims are not state evidence.
- Replace only expensive or nondeterministic boundaries such as external LLM HTTP, clocks, and IDs. Provider adapters, queues, loaders, Route Handlers, WorldHost, transactions, and persistence use real owned implementations. `ScriptedModelProvider` is for precise semantic tests.
- A failed execution proves revision, canonical state, and the policy roster remain unchanged. Cancellation and deadline tests prove that only complete steps persist.
- Strict schemas verify field ownership: models may name semantic IDs and candidate aliases; the engine materializes revision, step, phase, Profile, lifecycle, provenance, threshold ledgers, timestamps, and runtime IDs.
- Cognitive tests place conflicting truth and belief together and prove they do not overwrite each other. Public API tests search for canonical bindings, another Agent's belief, and Inspector payload leakage.
- Random tests fix the seed and prove check requests, DC, stakes, and distribution are committed before RNG extraction.
- Remote-model tests never print credentials, prompts, or raw responses and never replace deterministic semantic gates.
- `npm run test:live:qwen:batching`, `npm run test:live:glm:batching`, and `npm run test:live:deepseek:batching` are the credentialed eager-reference batching smokes. They execute real Blackmarsh Agent bootstrap and step preparation for their respective Profile sets, assert the default `12/8` limits, zero singleton failures, and invocation-ID uniqueness, and deliberately stop before the unchanged Truth-resolution boundary. The matching non-batching command remains the broader end-to-end smoke.
- A regression test fails for the escaped behavior before the fix and passes afterward, unless an existing deterministic reproduction already owns the contract.

## Direct runtime

Direct entry tests cover zero-inference startup, full Blackmarsh 49-subject admission, authorized private decisions, ordinary actions with creation disabled, exact material consumption, partial goal evidence, reusable capabilities, shared-resource queues, earlier deadlines, saved continuous activity, committed randomness, local model failure, no-progress waits, restart and recorded replay. Only the external model transport is replaced. Live qualification uses the same cumulative budget and records failed or censored tasks without claiming speedups. See [Spec 0182](specs/0182-jev-direct-world-runtime.md#verification).

## Reference algorithm compositions

- Composition tests prove recursive hash determinism, exact child schemas, strict canonical configuration, Role/version lookup, fresh instances, stable node paths, and independent child substitution. Catalog tests account for runtime and benchmark-only Algorithms; the static gate rejects generated-document drift and concrete Algorithm imports from fixed runtime, mechanics, or cognition code.

- Only decision-eligible model and external Agents produce new actions. Active Activities reuse their committed source action only when due; occupied, idle, and timed-out Agents produce no replacement action or noop.
- Grounding covers intersecting read/write/audience/resource-pool footprints, independent components, invocation-local repair for unknown dependencies, cross-component merge, and the rule that private IDs never enter the canonical catalog. It produces shared-resource claims in the same invocation and does not wake an unrelated occupied Agent; only an explicit canonical global reference enters the global component.
- Every new action receives one validated TemporalPlan from explicit text, a named script profile, or a trusted rule result. Tests reject arbitrary model seconds and prove fixed, rate, staged, conditional, ongoing, pause/resume/cancel, same-time due sets, and resource capacity.
- Every due action receives exactly one engine-preallocated outcome slot. `advance_time` is engine-generated, positive, and equal to the earliest absolute boundary; unrelated earlier boundaries cannot drift a later Activity checkpoint.
- Observation tests cover fixed Truth projection batches, complete materialization, permission checks, and observer-local repair. One observer exceeding its budget fails explicitly; a complete fixed batch exceeding `max_input_bytes` raises `ContextLimitExceeded` without shrinking.
- Truth Engine batches resolution, plan verification, transition, causal verification, and observation slots only for graph-proven independent work. Tests cover strict slot coverage, shared full context, local repair isolation, structural retry/bisection, canonical RNG ordering, completion-order determinism, cross-component closure, and replay audit identity.
- Action Compilation, AgentMind, Reaction, and Action Grounding tests cover independent limits one, two, three, twelve, and sixty-four; stable tails; profile and purpose isolation; byte shrinking; exact slot coverage; localized repair; structural retry and recursive bisection; terminal error propagation; singleton rollback or fallback; and one unique audit per physical request. Action Compilation additionally proves a complete unique candidate-key namespace, deterministic selective details, explicit shared/slot scope, zero serialized raw references, candidate-key materialization, bounded repair issues, trusted Inspector resolution evidence, and the promoted projector's production parity. Deterministic singleton and larger batches must commit the same canonical semantic result. Stage-overlap tests use latches to prove known compilation starts before resumed AgentMind completion while dynamic compilation still waits for its output.
- AgentMind consumes all authorized observations after the Agent's persisted cursor only at a decision point. Network, cancellation, configuration, or Ledger failures discard candidates. Exhausted semantic repair for one eligible Agent leaves a countable typed fallback and never fabricates belief. External, idle, and occupied Agents do not run AgentMind.
- A headless one-step run of Blackmarsh's 48 autonomous Agents is the structural regression. Domain actions may be blocked, partial, or noop, but the run cannot fail because of a missing outcome, missing time, or ID-namespace confusion.
- Registry conformance rejects invalid Roles or versions, non-JSON and non-canonical configuration, missing or additional child slots, recursive hash mismatches, reused instances, and factory identity mismatches. Instance tests prove descendant configuration changes the root manifest hash, survives restart, drives recorded replay, and that an unavailable or mismatched node fails before model work or mutation.
- Candidate-retrieval cache tests prove checksummed Float32 persistence, cross-process reads, exact world/fingerprint invalidation, cold read-only failure without file creation, process-local query LRU and single-flight behavior, and byte-identical cold/warm vectors. Runtime tests prove dynamic queries, one strict physical-batch budget, per-slot membership before FullCatalog materialization, cache failure before provider work, and no control-path Encoder load.
- Experiment tests prove domain-separated 10,000-bucket assignment, immutable persisted enrollment, explicit-tuning exclusion, missing historical manifest failure, activation evidence and world/fingerprint matching, treatment preflight before bootstrap, and a circuit breaker that stops only new enrollment. Inspector and report tests keep cohort, shortlist, cache, repair, terminal failure, token, transport, and latency evidence reconstructable without exposing experiment configuration through ordinary world APIs.
- Candidate tests prove version, exact generic interaction coverage, single-source audits and observations, frozen reaction identity/basis/policy provenance, replacement coverage, and committer-side reference, audience, claim-provenance, capacity, atomic-allocation, FIFO, holder-disposition, and retired-resource validation.
- Shared-resource scenarios prove deterministic `reject`, FIFO `queue`, joint `adjudicate`, capacity-four allocation, all-or-none multi-pool claims, pause retention/release, queue-head cancellation, assertion invalidation, capacity reduction, Entity retirement, release-to-ready promotion, and fresh timing on the next positive boundary.
- Runtime telemetry tests prove stable metrics exist without algorithm diagnostics, malformed stable events fail, replaceable work is attributed to the exact Composition path and manifest, due Activity/Timer/Condition and result dimensions remain reconstructable, aggregation follows the registered `sum | count | last | max` semantics, and mid-generation rollback retains model work while canonical state remains unchanged.

## World Instance and Participant

- A headless world supports single-boundary, ten-boundary batch, realtime wake/pause, and restart recovery. Scheduler tests use a fake clock to prove no reentry, no offline backlog, generation fencing, and scheduling only after the prior commit.
- ActionWindow uses internal two-Participant tests for collection, idempotent retry, conflicting submissions, timeout, disconnect, and revision CAS. Only external Agents at a decision point enter the window; a Participant with an active Activity is not asked at intermediate boundaries.
- Origin tests prove opening the dialog does not change the URL, cancellation leaves no orphan instance, and confirmation produces deterministic identity, spawn point, complete Mechanics Profile state, persona, goal, and display customization.
- Arrival tests prove it is the first persisted World message, reads only the authorized perspective, returns three suggestions without submitting them, falls back deterministically on failure, records complete Ledger evidence, and leaves semantic/state hashes unchanged.
- Participant-session tests prove one natural-language submission creates one persistent WorldRun, can project multiple revision-contiguous responses, and preserves the same message projection through refresh, retry, failure, pause, resume, budget pause, and restart. Participant composer never exposes batch or realtime controls.
- Agent Perspective tests verify deterministic containment, authorized self relations, private Fact exclusion, unbound and ambiguous identity handling, remote placement exclusion, complete subjective history, and required introductions for newly carried Entities or authorized property relations.
- Participant and Observer tests compare the full perspective before and after policy transfer, search for canonical identities or another Agent's private state, and prove takeover, exit, and direct switch restore model policy in one revision CAS.
- Control-orb and HUD tests cover drag restoration, moving Sheets, save, settings, perspective tools, focus return, generic predicates, desktop keyboard navigation, the mobile semantic relation list, reduced motion, advanced detach, and Inspector hidden by default.
- A closing overlay exits paint and hit testing before another Dialog opens. Accessibility scans wait for that state so transparent exit animation cannot alter underlying contrast measurements.
- Static-asset tests cover actual MIME, animation, dimensions, per-file and total budgets, path traversal, Unicode/case collisions, symlinks, and malicious ZIPs.
- Persistence tests cover cross-connection recovery, process-recovered WorldRuns, late-result cancellation, generation conflicts, corrupt-document rejection, validation cache, complete temporal replay, and pinned `WorldRuntimeContract`, `AlgorithmRef`, plus content-addressed world hash.

## Ledger and research reproducibility

- Execution Ledger tests prove complete requests, responses, and candidates can be retrieved by execution; critical write failure blocks revision; failed executions remain; Instance CAS and terminal record commit atomically.
- Recorded replay resolves the recorded producer through the registry, never accesses the network, and produces the same semantic and state hashes. Compare partitions transition, observation, and mind changes. Export derives only from original events and artifacts.
- Aggregate metrics reject high-cardinality Agent, Participant, Instance, Event, and invocation dimensions; subject detail remains queryable from traces.
- The 1/10/50/1000-Agent matrix crosses independent/sparse/dense/global causal conflict with none/sparse/dense shared-resource contention. It compares the production footprint index with an exhaustive oracle and the production allocator with an independent capacity/FIFO expectation; wall-clock results are recorded without a CI threshold.

## Maintenance budget

- One behavior has one primary evidence home. Add defense in depth only for a public contract, security boundary, migration, escaped incident, or similarly costly risk.
- Coverage locates unobserved code but is not a target or proof of quality.
- Remove or merge tests when behavior disappears, another test becomes primary evidence, or assertions constrain implementation without protecting a contract.
- A flaky test is a broken signal. Fix the uncontrolled boundary or quarantine it with an owner and repair condition; never normalize blind retries.
- Expensive fuzzing, mutation, visual, load, and large environment matrices require a repository risk that pays for their continuing cost.

The verification rationale is recorded in [0034](decisions/0034-truth-engine-verification-matrix.md), [0063](decisions/0063-eager-reference-execution.md), [0064](decisions/0064-conversation-core-and-agent-perspective-observer.md), and [0074](decisions/0074-enforce-script-owned-shared-resource-pools.md).
