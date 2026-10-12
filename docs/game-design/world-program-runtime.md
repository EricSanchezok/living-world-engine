# World Program Runtime

The world program kernel lives in [`src/engine/events/kernel.ts`](../../src/engine/events/kernel.ts). It is independent of private Agent programs. The registered `decision-event@1` candidate runs through WorldHost, SimulationEngine, CanonicalCommitter and history replay. The default Composition remains the baseline while schema replacement and qualification under [spec 0181](../specs/0181-jev-decision-event-engine.md) continue.

## Compilation and authority

`compileWorldProgram` projects canonical physical resources without Agent cognition or identity-binding maps. DeepSeek returns an immutable source-bound rule and parameter bindings. Sources include the world contract, laws, mechanics, and authored seed facts. Runtime testimony is evidence, not new rule authority. Admission checks exact source identities, parameter ownership, expression dependencies, effect shapes, and branch references. One targeted repair is allowed. Exhaustion retains a recoverable failure and all invocation evidence.

Effects are JSON templates. Dynamic leaves use `$expression` or `$text`; `$literal` escapes literal data. Code materializes templates into typed world operations. Generated rules cannot own time advancement or initialize quantities to bypass conservation. Fact and condition provenance is supplied by the kernel. Speech delivery must match the concrete utterance authored before the attempt.

Timing selects an authored temporal profile. Code derives fixed durations, travel rates, staged durations and open-ended checkpoints. Explicit quantities and durations must match evidence extracted from the action text. Each effect judgment sees its actual temporal plan and reads the selected profile version. An open-ended checkpoint cannot announce activity completion.

The compiler sends each canonical collection once; atomic read keys and authored fact sources address those same records. Repeated JSON-schema definitions use references. Stable world context precedes the attempt in the request layout. These are lossless layout choices, not removals of world evidence.

## Decisions and commits

Each semantic condition and candidate branch effect has a concrete yes/no/unknown question. Independent questions share one authorized world batch. Every batch includes its interaction partners, physical participant/containment envelope, and world laws. Mechanical expressions execute in code. Oversized inseparable questions use the gateway's explicit context fallback.

The native gateway preserves raw probabilities. Observed hundredth-precision Jev responses can sum to 0.99; validation allows only the corresponding bounded rounding interval (at most 0.02), while requiring complete domains, finite probabilities, and a maximal-probability choice. It does not renormalize distributions or use them for world randomness.

`WorldEventCandidate` binds programs, attempts, selected branches, materialized effects, deliveries, clock boundaries, random commitments, read versions/hashes, and full decision evidence. A selected branch must have all its conditions satisfied and its exact effects authorized. Missing or ambiguous branches remain uncommitted. Recorded answers must match the gateway's normalized output hash; changing an answer cannot reuse the original audit.

`commitWorldEvent` checks the earliest pending boundary, source hashes, actual read versions, canonical parameter ownership, decision bindings, causal assertions, references, write declarations, and quantity laws. It uses an isolated clone, so a later invalid operation rolls back the entire component. Physical time advances positively. `CommitReceipt` binds actual writes, events, and program receipts. Repeating a candidate with its durable receipt does not apply effects again. Identical no-op effects do not count as program progress.

World outcomes and private acknowledgements are distinct. An `attempted` acknowledgement confirms execution without disclosing an unobserved hit, failure or delivery. An `observed-outcome` acknowledgement requires a committed observation to the actor that establishes the exact outcome, checked by its source-bound effect judgment. Program progress uses changes visible in the actor's own perspective or deliveries to that actor; hidden canonical changes do not leak through its progress bit.

Random declarations bind exact authored distributions, purposes and complete branch stakes. `prepareWorldRandomPlan` freezes these inputs without extracting any RNG word or revealing the seed to the model. Jev must authorize applicability and stakes before code samples the seeded distribution. Result resources are read-only. The candidate retains before/after RNG, requests, results and authorization; commit and recovery reconstruct all of them. Unknown authorization does not draw. Model probabilities never enter this calculation.

Canonical timers and condition expiry are hard time barriers even if the calling scheduler supplies a later boundary. Due timers fire or cancel according to their code-evaluated assertions; only firing timers wake their declared subjects. A timer-only boundary commits without model work. An empty event cannot advance time without an actual due boundary. World event judgments also see authored timers.

## Local scheduling

`EventScheduler` retains a canonical pending queue and completed identities. An unresolved earlier event prevents acknowledging a later one. Owner-specific subscriptions wake only on relevant resource versions, receipts, or deadlines. Replaced subscriptions cancel superseded deadlines. Evaluation fingerprints detect repeated input/frontier without committed progress, including cycles through other frontier states and restart.

`jointActionComponents` connects read/write conflicts, shared actors, and interacting recipients transitively. Independent components can prepare concurrently; the queue retains commit order.

Private control restores checksummed libraries, program journals, receipts and pending attempts. Local wakeups run goal selection and program predicates through Jev; only new programs and concrete utterances call creation. Independent owners run concurrently with separate invocation ordinals, and all in-flight outcomes settle before failure propagates. A pending issued attempt is not issued again on restart. World rules can reuse the same private definition/node/parameter binding with a new `utterance` parameter, without regenerating the rule. Preparation preserves failed attempts for a relevant dependency change.

Failed world judgments retain the complete actual read union, bound source hashes and judgment evidence identities. Unknown conditions whose policy is wait remain suspended until one of those inputs changes. Rejected effect interpretations bypass the rejected library entry and receive one targeted creation revision. The revision budget binds the input before revision, so changing a generated read declaration cannot reset it. Structural repair exhaustion waits on the complete compiler input. Unrelated world mutations do not wake a semantic wait.

## Simulation entry and recovery

`DecisionEventAlgorithm` pins the creation, decision and context-fallback profiles, registry snapshot, program definitions and dependency-round limit in the instance's execution state. Bootstrap covers actual private goals without changing canonical time. A control commit advances the revision only; a physical event also advances the world step and strictly positive elapsed time. A quiescent world raises a typed waiting result instead of minting repeated empty revisions.

The fixed committer re-executes newly appended private instructions against the owner's actual resources. Generated definitions are re-admitted, creation output hashes are checked, semantic decisions are reconstructed from concrete frontier tickets, and issued attempts must match their private program or authorized player submission. Reusing an existing immutable plan rechecks today's source identity and reference catalogs; unrelated additions to the admission environment do not invalidate its original creation evidence. Persistent goal questions include the original goal, even when a generated mechanical condition is true. Completion checks run before replacing an ended program.

Player text remains an attempted action. Creation renders exact spoken content before world adjudication; canonical delivery establishes who actually heard it. A controller change interrupts private planning and revokes unstarted or interruptible pending work. Noninterruptible work retains its already established execution boundary. Resuming model control creates a local wakeup.

World settlement consumes exactly the persisted pending frontier. Private deadline queue items must come from the active interpreter. Canonical event evidence, actual observations, belief revisions and program receipts are replayed by the same deterministic implementation used for preparation and commit. Native history has source-bound decision evidence; it does not invent a legacy `causal-verifier` invocation.

## Observation and cognition

`projectEventPerception` requires matching candidate and committed receipt hashes. Only explicit committed deliveries become observation packets. A known private speaker alias can be reused; an unidentified speaker receives a neutral local alias without canonical names or hidden identity claims. Hearing testimony adds evidence that words were heard and does not assert that their contents are true.

`reviseEventBeliefs` asks independent questions about the owner's existing claims using only that owner's authorized perspective. Supported and contradicted answers update stance; insufficient or irrelevant evidence leaves the claim unchanged. Probability is retained in the decision audit and does not replace epistemic confidence. `applyEventBeliefs` reconstructs the exact private input and derives the patch again from the recorded output during commit or replay. New evidence remains available directly to program predicates, including when there are no existing claims to revise.

## Verification boundary

Tests exercise the actual ModelGateway with only HTTP replaced, compilation/repair, quantity transfers, stale reads, unrelated updates, source/evidence tampering, unknown, atomic competition failure, exact speech, no-op progress, and scheduler restart. SimulationEngine tests also cover registered execution, natural-language player actions, actual speech delivery, same-time control commits, controller interruption, quiescence, persistent replay and recovery without repeated effects. A real-model diagnostic is available as `scripts/experiments/jev-world-smoke.ts`, consuming a successful private-program probe. It exercises the world kernel directly, not WorldHost persistence or a complete game.

WorldHost lifecycle integration and the local Inspector expose native programs, coverage, wake reasons, decisions and measured call costs. Schema upgrades, default replacement and full A/B/C qualification remain subsequent work. Passing the runtime checks does not establish the acceptance targets.
