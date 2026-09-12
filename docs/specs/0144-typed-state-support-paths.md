# Typed state support paths experiment

Artifact-Version: 1
Status: Approved

## Intent

Test whether graph retrieval confuses admissible output uses with evidence relationships under the authorized [player action efficiency experiment](0122-player-action-efficiency.md). An actor or target can have relevant inventory, ratings, meters and placement even when those candidates cannot themselves fill the target output field. This experiment changes graph evidence only; it does not change default retrieval or canonical permissions.

## Contract

Freeze a baseline using the existing field-use-constrained traversal and one explicit `typed-state-support` candidate. In the candidate, actor and target paths can additionally reach quantity, rating, meter and placement candidates through their matching entity-state relation. All other traversal predicates, relation priorities, depth limits, scopes, candidate kinds, output uses, lexical/dense signals, pseudo-seeds, batch membership, mandatory anchors, compact-kind allocation and total budget remain unchanged. Do not infer state, attach unrelated state by label, require all attached state in the shortlist, or expand the budget.

Capture graph evidence from the same physical retriever that computes rankings: original anchors and roles, and the resulting per-candidate depth and priority. A trace callback receives a snapshot, cannot mutate the active path map, and adds no model-visible context. The default policy retains existing ranking values with tracing enabled or absent. Profile paths and slot-private candidates retain their existing boundaries.

First reproduce actor and target inventories being absent from anchor paths using real graph construction and physical ranking with only the encoder boundary replaced. The candidate must expose the explicitly attached state, retain each candidate's allowed uses, preserve unsupported and private exclusions, and reject an unknown policy. This proves a graph mechanism, not source relevance or a shortlist improvement.

Compare the unchanged selector on all five original batches and 49 actions using frozen complete-text query vectors and their matching read-only passage cache. Verify baseline scores, ranking order and full selected contexts against the recorded source before interpreting the candidate. Bind original queries, vectors, contexts, implementation and policy identities. Preserve full graph traces, ranking changes, added/removed source records, all historical-reference omissions and local costs. Review new losses and previously observed omissions against original action intent. Historical model output is warning evidence, not gold.

No provider HTTP, output rewriting, default promotion, world mutation or player-latency claim is part of this offline comparison. The complete-text encoder remains a separate unqualified representation. Any later promotion needs independent semantic and full-player evidence.

## Plan

1. Add graph trace snapshots and the isolated relation-specific policy at the shared physical ranking boundary.
2. Exercise path and scope counterexamples through that boundary.
3. Freeze source-bound complete-cohort comparisons, review negative evidence, and retain the result.

## Verification

Run focused physical-retriever tests, the complete frozen-source comparison and `npm run check:fast`. Assert unchanged baseline outputs, original slot and action coverage, exact vector reuse, immutable trace snapshots, original budgets and unchanged allowed uses.

## Evidence

The [physical retriever](../../src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf.ts) owns the graph policy and trace boundary. Its [state-path tests](../../src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf-state-paths.test.ts) establish the mechanism and remaining boundaries. [The decision](../decisions/0196-separate-state-evidence-from-target-uses.md) records alternatives and limits.
