# Action Compilation Candidate-Key v2

Artifact-Version: 1
Status: Implemented

## Intent

Shorten the request-local Action Compilation selector so models have fewer characters to transcribe while retaining a complete closed candidate namespace, deterministic replay, and strict semantic validation. The change is forward-only and does not broaden fuzzy matching to canonical IDs, proposal keys, free text, or arbitrary identifiers.

## Contract

Action Compilation candidate keys use the exact format `candidate_` followed by twelve lowercase hexadecimal characters. The suffix is derived deterministically from the request-local handle using the engine-owned digest and has no canonical identity meaning. The Action Compilation reference catalog is version 2, the model context contract is version 16, and the audit projection is `candidate-key-v3-complete-repair-issues`.

The projector derives every emitted key from its engine-owned handle and never trusts a stale model or fixture key. The candidate namespace remains complete, shared and slot-private scope is preserved, and duplicate generated keys fail closed. Materialization validates the exact schema before resolving keys. The existing symbol-repair policy may repair only registered closed-set symbols with a protected prefix, a payload of at least eight characters, bounded Damerau distance at most three, and a unique best candidate with the configured margin; all repaired values pass the complete schema, scope, kind, use, mechanic, temporal, and transaction checks again.

The eager-reference algorithm manifest is version 14 and records candidate-key version 2, payload length 12, and the opt-in candidate-retrieval component. Persisted instances pinned to earlier manifests are obsolete saves under the repository's forward-only policy; no migration or compatibility reader is provided.

## Plan

Use one shared protocol constant for the key format, catalog version, audit projection, and manifest component. Update the Action Compilation projector, compiler audit, model contracts, Inspector parser, prompt, fixtures, and current-state documentation. Keep generic `ref:*` catalog version 2 and all non-Action-Compilation symbol domains exact-only unless explicitly registered.

## Verification

Unit tests prove exact twelve-hex validation, deterministic key generation, catalog versioning, collision protection, and unchanged bounded repair semantics. Inspector and Action Compilation integration tests prove projection parsing, key materialization, slot isolation, and repair audit evidence. Run `npm run benchmark:action-compilation`, the focused model/context/eager-reference suites, `npm run check:fast`, `npm run build`, bundled-world validation, and local startup acceptance with a newly created instance.

## Evidence

- [Action Compilation context tests](../../src/engine/algorithms/eager-reference/__tests__/action-compilation-context.test.ts) cover the v2 catalog and exact key shape.
- [Model context tests](../../src/engine/contracts/__tests__/model-context.test.ts) cover the twelve-hex schema boundary.
- [World Inspector model-invocation tests](../../src/server/__tests__/world-inspector-model-invocations.test.ts) cover the v2 audit projection and symbol-repair evidence.
- The eager-reference manifest and model audit include the versioned protocol in replay and execution hashes.
