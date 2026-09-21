# Incremental Intent Execution

Artifact-Version: 1
Status: Approved

## Intent

Implement an executable residual-program kernel for the complete-player optimization authorized by [Spec 0122](0122-player-action-efficiency.md). The kernel separates pending intentions from issued attempts and completed work. It is an experimental lifecycle component, not another model-visible initial-frontier annotation.

## Contract

Only an explicitly supplied, validated model-authored intent program enters the kernel. Its complete original action, ordered local targets and source hash remain available. Ordinary player prose is not parsed as executable control syntax. Sequence exposes its first unfinished child; parallel exposes all unfinished children; if, while and await stop at an unevaluated guard. An attempt remains arbitrary natural language, not an operation or an automatic success.

Each activation has a stable unique work identity. Issuing an attempt binds one exact child action allocated by the engine's preparation boundary and prevents duplicate dispatch across snapshot restoration. Its owner, text, goal, means and ordered targets must match the current attempt; action identities cannot be reused across activations. Only a matching completed Activity with one succeeded action outcome in its terminal commit advances that attempt. A completed scheduled interval alone does not establish action success. A checkpoint, successful check, outcome sentence, active or paused Activity does not complete it. Partial, failed, blocked or cancelled attempts stop new dispatch and request replanning; the kernel does not cancel sibling Activities or roll back their effects. Suspension preserves issued work and all pending branches.

Guard decisions are bound to the exact work identity and owning AgentPerspectiveView. Unknown preserves every branch. A false await retains its waiting node; the same perspective cannot trigger another identical guard request. A while body completing creates a new guard activation rather than reusing an earlier answer. The kernel does not evaluate natural-language conditions, infer canonical truth, or certify a model's decision as semantically correct.

Snapshots retain the complete source and replay journal, from which remaining structure, issued actions and consumed evidence are reconstructed. Restore rejects digest mismatches and illegal event order. The journal is engine-owned trusted storage; its digest is not authentication against a writer who can replace both the journal and digest. This kernel is benchmark-only and is not registered as a world Composition. Product state schemas, ordinary cognition, action compilation, world commits and production defaults remain unchanged. Host integration must separately bind cursor persistence to the same atomic world transaction, resolve parallel resource admission and interruption, and provide qualified private guard decisions before full-player adoption.

## Plan

Implement the residual interpreter and immutable snapshot boundary. Exercise sequence, parallel, branch, loop, wait, interruption, duplicate/stale evidence and restart through the real temporal Activity reducer and private perspective projector. Run a source-bound structural audit over all forty-eight recorded NPC programs while retaining the external player's ordinary action. Report controlled execution evidence separately from new model or gameplay results.

## Verification

Reject future-node dispatch, cross-owner perspectives, unissued or wrong-source Activities, noncommitted revisions and duplicate completion. Verify exact remaining program and target preservation, no replay after restore, no unknown-to-false conversion, no loop guard reuse, and no world mutation. Run relevant tests and check:fast before the independent local commit. Subsequent model screens and the complete forty-nine-subject test retain the original latency, repair, semantic and feedback acceptance criteria.

## Evidence

[Decision 0222](../decisions/0222-execute-residual-intention-programs.md) records the alternatives and primary algorithm source. [The cursor kernel](../../src/engine/benchmarks/step-efficiency/intent-execution-cursor.ts) owns execution and snapshot rules. [The source audit](../../scripts/experiments/intent-execution-audit.ts) checks complete historical input, target preservation and serialization without model calls or world execution.
