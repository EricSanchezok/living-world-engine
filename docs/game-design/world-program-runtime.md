# World Program Runtime

The world program foundation lives in [`src/engine/events/kernel.ts`](../../src/engine/events/kernel.ts). It is independent of private Agent programs. The production SimulationEngine and WorldHost still use the existing execution Composition; integration and qualification under [spec 0181](../specs/0181-jev-decision-event-engine.md) remain pending.

## Compilation and authority

`compileWorldProgram` projects canonical physical resources without Agent cognition or identity-binding maps. DeepSeek returns an immutable source-bound rule and parameter bindings. Sources include the world contract, laws, mechanics, and authored seed facts. Runtime testimony is evidence, not new rule authority. Admission checks exact source identities, parameter ownership, expression dependencies, effect shapes, and branch references. One targeted repair is allowed. Exhaustion retains a recoverable failure and all invocation evidence.

Effects are JSON templates. Dynamic leaves use `$expression` or `$text`; `$literal` escapes literal data. Code materializes templates into typed world operations. Generated rules cannot own time advancement or initialize quantities to bypass conservation. Fact and condition provenance is supplied by the kernel. Speech delivery must match the concrete utterance authored before the attempt.

The compiler sends each canonical collection once; atomic read keys and authored fact sources address those same records. Repeated JSON-schema definitions use references. Stable world context precedes the attempt in the request layout. These are lossless layout choices, not removals of world evidence.

## Decisions and commits

Each semantic condition and candidate branch effect has a concrete yes/no/unknown question. Independent questions share one authorized world batch. Every batch includes its interaction partners, physical participant/containment envelope, and world laws. Mechanical expressions execute in code. Oversized inseparable questions use the gateway's explicit context fallback.

The native gateway preserves raw probabilities. Observed hundredth-precision Jev responses can sum to 0.99; validation allows only the corresponding bounded rounding interval (at most 0.02), while requiring complete domains, finite probabilities, and a maximal-probability choice. It does not renormalize distributions or use them for world randomness.

`WorldEventCandidate` binds programs, attempts, selected branches, materialized effects, deliveries, read versions/hashes, and full decision evidence. A selected branch must have all its conditions satisfied and its exact effects authorized. Missing or ambiguous branches remain uncommitted. Recorded answers must match the gateway's normalized output hash; changing an answer cannot reuse the original audit.

`commitWorldEvent` checks the earliest pending boundary, source hashes, actual read versions, canonical parameter ownership, decision bindings, causal assertions, references, write declarations, and quantity laws. It uses an isolated clone, so a later invalid operation rolls back the entire component. Physical time advances positively. `CommitReceipt` binds actual writes, events, and program receipts. Repeating a candidate with its durable receipt does not apply effects again. Identical no-op effects do not count as program progress.

## Local scheduling

`EventScheduler` retains a canonical pending queue and completed identities. An unresolved earlier event prevents acknowledging a later one. Owner-specific subscriptions wake only on relevant resource versions, receipts, or deadlines. Replaced subscriptions cancel superseded deadlines. Evaluation fingerprints detect repeated input/frontier without committed progress, including cycles through other frontier states and restart.

`jointActionComponents` connects read/write conflicts, shared actors, and interacting recipients transitively. Independent components can prepare concurrently; the queue retains commit order.

## Verification boundary

Tests exercise the actual ModelGateway with only HTTP replaced, compilation/repair, quantity transfers, stale reads, unrelated updates, source/evidence tampering, unknown, atomic competition failure, exact speech, no-op progress, and scheduler restart. A real-model diagnostic is available as `scripts/experiments/jev-world-smoke.ts`, consuming a successful private-program probe. It exercises the world kernel directly, not WorldHost persistence or a complete game.

Random commitments, observation/cognition delivery, timer-only physical boundaries, production persistence, Inspector, schema upgrades, and full A/B/C qualification are subsequent integration work. Passing these foundational checks does not establish the acceptance targets.
