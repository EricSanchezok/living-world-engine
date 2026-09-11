# AC-FP1 execution reference

This directory owns the pre-output intent constraints for [Approved Spec 0023](../../../../docs/specs/0023-action-compilation-first-pass-experiment.md). The [machine protocol](../../../../src/engine/benchmarks/action-compilation/first-pass-protocol.ts) owns the sources, arms, schedules and analysis gates; the [budget policy](../../../../src/engine/benchmarks/action-compilation/experiment-budget.ts) owns expenditure limits and conservative pricing. The Notion record owns measured results and execution issues.

## Operator procedure

The source input is the official `source-staging/` capture shard under `.livingworld-benchmarks/experiments/ac-fp1/v1/`. The commands read that capture and the installed local retrieval resources, not arbitrary save JSON. They do not mutate the game database. The normal provider consumes the credential already configured in the process environment; do not copy credentials into artifacts or command arguments.

```sh
npm run experiment:action-compilation -- preflight
npm run experiment:action-compilation -- verify
npm run experiment:action-compilation -- freeze
npm run experiment:action-compilation -- run --phase discovery
npm run experiment:action-compilation -- run --phase discovery --live --authorization approved-spec-0023-cny-1000
npm run experiment:action-compilation -- score --phase discovery
```

`verify` requires a clean committed tree and records checks against the exact source fingerprint. `freeze` requires that verification and rebuilds the original contexts through actual local R5 retrieval. All four sources, sixteen arm contexts/schemas/dictionaries, protocol, oracle and verification become a checksummed immutable snapshot. The first `run` above is deliberately offline; only the explicit live command can send requests.

`score` writes a content-addressed `scores/<hash>/` containing `metrics.json`, `review-pack.json`, `report.md` and checksums. Missing trials, unknown usage, unresolved intent and absent safety review remain visible. Formal acceptance and semantic success are separate. The review pack omits arm, cost, call order and historical success, while preserving exact source actions, canonical compilations and the identity needed to consult frozen state and constraints.

Adjudications live in append-only `semantic-verdicts.jsonl`, validated by [the verdict schema](../../../../src/engine/benchmarks/action-compilation/first-pass-oracle.ts). A verdict binds the exact oracle, state, action and canonical compilation hashes, includes must/forbidden findings and evidence artifacts, and names its reviewer and evidence kind. No verdict means unresolved. An LLM's opinion is not a human adjudication or deterministic proof. Reusing a verdict requires exact hashes, never approximate text similarity. If any intent failures occur, a `semantic-safety-review.json` binds the frozen and verdict hashes and records whether those failures introduce protocol-level failure mechanisms; lack of that review does not silently pass safety.

Only a complete, adjudicated, eligible discovery score seals `discovery-winner.json`. Confirmation reads that seal rather than accepting a caller-selected arm:

```sh
npm run experiment:action-compilation -- run --phase confirmation --live --authorization approved-spec-0023-cny-1000
npm run experiment:action-compilation -- score --phase confirmation
```

Completed trials are reused only as durable progress, never redrawn. An interrupted trial or stop reason requires evidence reconciliation; a stale process lock alone does not authorize a new send. Unknown provider usage blocks further sends. Each actual HTTP send has a flushed reservation and request body before network work, and a response plus usage settlement afterward. Headers and credentials are not retained. Score/report commands are offline. No command changes the production default or publishes a branch.

## Offline mechanism coverage

The [mechanism configuration](../../../../scripts/experiments/ac-fp1-mechanisms.config.ts) reuses owned scenarios through the real compiler, mechanics, Truth verification and kernel. Its provider-boundary instrumentation passes canonical model values through AT encode/decode before the original compiler consumes them, asserting exact equality. Deliberately nonexistent canonical references remain invalid inputs to the original validator; they are not legal inputs to the bijection. Actual short-alias rejection and repair are separately exercised through the real gateway. This suite is not a second LLM or a live-world realism benchmark.

| Mechanism family | Evidence home |
| --- | --- |
| Fixed, rate, staged; conditional and ongoing | [Six-boundary normal, related and unrelated counterfactuals](../../../../src/engine/algorithms/eager-reference/__tests__/representation-trajectories.test.ts) |
| Assertion union, reference values and ordered conjunction | [All branches and 1,000 seeded combinations](../../../../src/engine/algorithms/eager-reference/__tests__/action-compilation-representation.test.ts), plus the temporal counterfactuals above |
| Pause, resume and cancel | The temporal counterfactuals and [resource lifecycle scenarios](../../../../src/engine/mechanics/__tests__/shared-activity-resources.test.ts) |
| Interruption and simultaneous action | [Eager-reference safeguard scenarios](../../../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts): reaction replacements, onset checks and same-time boundaries |
| Shared resources | [Real admission/allocation matrix](../../../../src/engine/mechanics/__tests__/shared-resource-allocation.test.ts) and eager-reference capacity/FIFO commits |
| Dependencies and audience | Eager-reference dependency rejection, component merge and authorized observation scenarios |
| Causes, checks and random commitments | [Mechanics test suite](../../../../src/engine/mechanics/__tests__/) and the codec's complete cause/assertion branches |
| Truth, belief and player knowledge | [Perspective](../../../../src/engine/cognition/__tests__/agent-perspective.test.ts), [observations](../../../../src/engine/cognition/__tests__/observation-renderer.test.ts) and eager-reference observation/decision scenarios |
| Composite open actions | Temporal counterfactuals preserve arbitrary original text, new tools/helpers and multi-step descriptions; codec tests leave prose and opaque JSON untouched |
| Atomicity and illegal input | [Kernel tests](../../../../src/engine/runtime/__tests__/execution-kernel.test.ts), eager-reference rollback/capacity scenarios and [actual gateway trials](../../../../src/engine/benchmarks/action-compilation/first-pass-runner.test.ts) |
| Identity, repair and replay | [Representation runtime tests](../../../../src/engine/algorithms/eager-reference/__tests__/represented-action-compiler.test.ts), kernel manifest checks and [causal activity replay matrix](../../../../src/engine/benchmarks/causal-activity-benchmark.test.ts) |

The matrix composes exact representation invariants with existing positive/negative world-result assertions. It does not claim that every naturally generated action has an independently reviewed semantic label. Confirmation claims require the separately frozen intent evaluation, complete accounting and all statistical gates.
