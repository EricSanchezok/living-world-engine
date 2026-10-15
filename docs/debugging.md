# Local Debugging Reference

This document is the current reference for diagnosing the Living World Engine with a Codex-class coding agent. It describes the shipped CLI, Ledger query projections, identifier relationships, evidence rules, and verification commands. The reusable procedure lives in the [debugging skill](../.agents/skills/debugging/SKILL.md); this document is the single home for the underlying contract.

## Fast path

```sh
npm run debug:doctor
npm run debug -- find --invocation '<execution-id>::<source-invocation-id>' --format json
npm run debug -- inspect --invocation '<execution-id>::<source-invocation-id>'
npm run debug -- lineage --invocation '<execution-id>::<source-invocation-id>'
npm run debug -- explain '<diagnostic-code>'
# Immutable Ledger replay (the default)
npm run debug -- replay '<execution-id>'
# Explicit counterfactual replay using one probe trial
npm run debug -- replay '<execution-id>' --probe-report '<report.json>' --trial 1
```

Use `--database <sqlite>` when the active data root is not `.livingworld-v28/`. All commands accept `--format json` (default), `--format ndjson`, and `--format table`. Add `--payload` to `inspect` or `events`, or use `artifact --artifact <hash>`, when complete JSON evidence is required. `--output <file>` prevents large results from consuming the Agent context.

## Identifier contract

| Identifier | Meaning | Primary lookup |
| --- | --- | --- |
| `executionId` | One recorded execution boundary | `debug find --execution` |
| `public invocation id` | `executionId::sourceInvocationId` | `debug find --invocation` |
| `sourceInvocationId` | Producer-local model call identity | `debug find --source-invocation --execution` |
| `requestId` | One HTTP request scope | `debug find --request` |
| `traceId` / `spanId` | Runtime DAG identity | `debug find --trace` / `--span` |
| event sequence | Global Ledger event identity | `debug events --event` |
| artifact hash | Content-addressed request, response, candidate, or error | `debug artifact --artifact` |
| diagnostic code | Stable failure or degradation category | `debug find --issue` / `debug explain` |

The public invocation ID is a query identity, not a replacement for the Ledger event sequence. Keep both when recording evidence.

## CLI reference

```text
debug find       Search indexed executions, invocations, and events
debug inspect    Show one logical invocation and its event summaries
debug lineage    Show parent, repair, retry, and child relationships
debug events     List runtime event summaries without unrelated payloads
debug artifact   Read one complete content-addressed artifact
debug explain    Show diagnostic owner, source, tests, and commands
debug doctor     Check schema, projection counts, orphan rows, and drift
debug replay     Replay recorded model outputs through the pinned algorithm
debug compare    Compare two executions by semantic partitions
debug export     Export execution evidence and derived metrics
```

Stable exit codes are `0` for success, `2` for no match, `3` for invalid arguments, `4` for Ledger or index integrity failures, and `5` for an operational command failure. Errors are JSON objects with a stable code, retryability, and suggested commands.

Replay is immutable by default: it reads only the source execution's recorded
model outputs and creates a `replay` child. Passing `--probe-report` opts into
`mode: "probe-overlay"`; `--trial` selects one exact-request trial (default
`1`) from that explicitly supplied v1 `model-invocation-probe` report. The
selected accepted output is normalized output, while a rejected trial enters
the normal `ModelOutputError` repair path. Profile, prompt, schema, context, or
request-hash drift is rejected, transport/configuration failures are not
overlayable, and no report file is discovered automatically. Overlay engine
failure is returned as `replayStatus: "failed"` with a failed child execution
and a zero command status; malformed or mismatched evidence remains non-zero.
Every overlay child stores the redacted report artifact and records
`probeNetworkAccessed: true` versus `replayNetworkAccessed: false`.

## Evidence layers

The `execution_events` and `execution_artifacts` tables are the only durable execution facts. `execution_event_index`, `execution_issue_index`, and `execution_invocation_index` are rebuildable SQLite projections used for exact lookup and pagination. `npm run debug:doctor -- --rebuild-index` reconstructs them from the Ledger and reports any corrupt artifact or orphan reference.

Metadata queries do not inflate unrelated artifact bodies. Artifact content is decompressed only for an explicit payload request or index rebuild. Payloads are always passed through the existing credential redaction boundary before persistence.

## Diagnostic ownership

`debug explain <code>` is the authoritative route from a failure category to source and test ownership. The current catalog includes transport, model-output, semantic-validation, execution-rollback, persistence, Inspector lookup, and unknown runtime failures. Add a new definition when a recurring failure needs a stable owner or recovery recipe; do not create synonyms for an existing code.

## Reproduction and verification

Use the existing real boundaries and preserve the world invariant that failed execution does not advance canonical revision or state. Use recorded replay for model-independent reproduction and compare for partition-level differences. Use deterministic providers, clocks, and IDs only at expensive or nondeterministic boundaries.

```sh
npm test -- src/server/__tests__/debug-query.test.ts
npm test -- src/app/api/__tests__/instance-routes.test.ts
npm run typecheck
npm run check:fast
npm run check:ui
```

Every bug report or Agent handoff must separate Ledger facts, reasoned hypotheses, and unresolved questions, and must include the smallest command that reproduces the observation.
