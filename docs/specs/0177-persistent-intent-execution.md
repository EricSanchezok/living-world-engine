# Persistent Intent Execution

Artifact-Version: 1
Status: Approved

## Intent

Connect residual intention execution to real world preparation, atomic persistence and player execution under [Spec 0122](0122-player-action-efficiency.md). Qualification requires the complete forty-eight-NPC world and a separate external human, including actual Activity completion and durable feedback.

## Contract

Simulation state retains an engine-owned execution-state document bound to the exact root Composition hash. The document is private algorithm control state, not canonical truth, an Agent belief or a model-authored world delta. Preparation freezes its proposed next value. The committer accepts only that frozen value with the same producer, records it in the semantic history and persists it with the world transaction. Rejected or cancelled work cannot advance the persisted document. Replay reproduces it exactly, and switching producers with pending control state is rejected. The state schema advances directly; old saves are not migrated.

The incremental diagnostic retains the complete model-authored program and every pending branch. It consumes already committed results at the next preparation boundary; this avoids a cursor digest depending on the same commit that contains it. Issued work and the resulting world commit therefore survive together, and restart can consume the result without reissuing the work. Conditions use the owning Agent's perspective, preserve unknown and are recorded with their input evidence. A model can continue or replace an intention as part of ordinary cognition. External player prose remains an ordinary action and is never parsed as engine control syntax.

Known and resumed action compilation share one unchanged planning snapshot until both branches settle, including all local repairs. Intention selection accumulates the proposed control state separately. Preparation publishes the complete value to its planning state only after those readers finish; failed preparation publishes neither world state nor control state. Candidate-selection reuse retains its full source-state hash check.

Replacement and private intention context use the [recursive producer](0164-recursive-intent-tree-screen.md). Models author embedded children and per-leaf local targets; deterministic lowering derives all internal node identities and target indices before the execution cursor consumes them. The continue/replace wrapper preserves the producer's complete wire-schema reference definitions, local target domains and downstream private-reference validation. No model-authored graph bookkeeping or parallel indexed producer is part of this diagnostic.

Multiple currently executable intentions of one Agent remain one explicit parallel attempt group. Every member and its ordered local targets are preserved. The existing joint semantic adjudicator and resource allocator determine feasibility, timing and effects. Only successful completion of the whole group completes its members; partial or failed work requires replanning without rolling back effects. A waiting or unchosen future node does not become an active attempt. This grouping neither establishes causal independence nor certifies physical concurrency.

The candidate is an explicitly selected diagnostic Composition. Production defaults do not change before full-player qualification. New guard work, context size, token usage, physical calls, repairs and all player-visible timing remain countable. No reduction in NPC count, semantic freedom, action completeness or feedback requirements can be used as a speed result.

## Plan

Add producer-bound execution state to the canonical persistence and replay path. Connect intention selection and cognition continuation through explicit algorithm seams. Register and pin one complete diagnostic, validate restart and failure through WorldHost, then run official deepseek-flash with thinking disabled against all forty-nine subjects. Review the actual committed world, repair causes and feedback before another trial or promotion.

## Verification

Prove matching preparation ownership, atomic rollback, restart and history replay with real runtime and database boundaries. Exercise parallel groups, private guards, replacement and ordinary player prose. Run check:fast before the local commit. Live results must separately report source qualification, initial rejection, repair recovery, terminal failure, completed Activities, persisted feedback and submission-to-completion latency.

## Evidence

[Decision 0223](../decisions/0223-persist-algorithm-execution-state.md) owns the storage choice. [Spec 0176](0176-incremental-intent-execution.md) owns residual-program semantics.
