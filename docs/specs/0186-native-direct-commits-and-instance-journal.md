# Native Direct commits and instance journal

Artifact-Version: 1
Status: Implemented

## Intent

The human's 2026-10-15 instruction approves replacing Direct's reference-pipeline adapter, duplicate state storage and repeated trial application, with clear ownership and preserved validation and replay. Work happens in the primary checkout on main. Superseded representations are removed; old saves receive no migration or compatibility implementation. Research reference algorithms retain their explicitly selected evidence paths, without defining Direct's execution protocol.

## Contract

- Direct prepares a native, input-bound event and returns that candidate without applying it. The canonical owner verifies the frozen preparation, producer, actual reads, time ordering, random commitments and mechanical invariants, then applies it once. Recorded replay uses the same mechanical owner without inference.
- Direct preparation, candidates and committed records contain their own required fields. Reference-only resolution, reaction and cognition fields are absent. Debug stages describe actual Direct work.
- Current control state has one owner. Committed Direct events retain lossless, hash-bound control changes rather than duplicate full control snapshots. Inspector and recovery reconstruct historical control from those changes.
- SQLite stores immutable content-addressed JSON blocks shared by instance roots and Ledger artifacts. Large current-state, historical and narrative subtrees have independent block identity. An update inserts changed blocks and updates the instance root without rewriting old history or duplicating snapshot artifacts. Instance generation checks, process leases and terminal execution writes remain atomic. Missing, changed or reordered historical records fail closed.
- Every authoritative event, observation, model decision and published paragraph remains recoverable. Refresh, restart, failure recovery, Inspector and recorded replay preserve the same semantics. Obsolete serialized contracts are rejected explicitly.
- Changes preserve script-driven mechanics, private cognition boundaries and full trusted-local diagnostics. No paid model evaluation is required for this structural change.

## Plan

1. Replace Direct execution wrappers and remove trial application; retain a distinct reference protocol at the algorithm boundary.
2. Remove repeated control snapshots, normalize instance persistence and update readers directly.
3. Exercise tampering, restart, atomic rollback, narrative persistence and deterministic replay; update the owning references and commit checked units locally.

## Verification

Run focused Direct runtime, activity, WorldHost, persistence, Inspector and replay tests. Add permanent regressions for native protocol shape, unchanged source during candidate creation, rejected tampering, one canonical application, append-only storage and byte growth independent of old history during narration. Run `npm run check:fast` before each implementation commit.

## Evidence

- [Direct runtime regressions](../../src/engine/direct/__tests__/runtime.test.ts) verify native envelopes, no trial application, one canonical application, frozen-event rejection, control-delta integrity and replay.
- [Immutable block tests](../../src/server/__tests__/json-block-store.test.ts) cover content reuse, paragraph byte growth against 10 and 1,000 historical records, scalar/tag collisions, independent mutable hydration, corruption and rollback.
- [WorldHost persistence tests](../../src/server/__tests__/world-instance-host.test.ts) verify instance/Ledger sharing, terminal-write failure atomicity, CAS, cold reads and cache invalidation after storage damage.
- [Direct WorldHost tests](../../src/server/__tests__/direct-world-host.test.ts) exercise real entry paths, Inspector, streamed paragraphs, restart, failure recovery and recorded algorithm replay without network calls.
- `npm run check:fast` and `npm run check:ui` are the completion gates.
