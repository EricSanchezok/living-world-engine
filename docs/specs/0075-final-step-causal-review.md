# Final Step Causal Review

Artifact-Version: 1
Status: Approved

## Intent

Make causal acceptance cover the actual atomic step, including observations rendered after component merging and activity settlement. This implements the authorized nonthinking gameplay optimization and the coverage guardrail in [postmortem 0089](../postmortems/0089-causal-review-lost-preparation-reactions.md).

## Contract

Component sessions prepare mechanically valid effects without rendering observations or granting acceptance. The coordinator merges effects, reconciles activity outcomes, settles observation-triggered activity contexts and resource queues, then renders final observations. Observer coverage expands monotonically when lifecycle changes require all live Agents; settlement is recomputed from the same temporal base before rendering.

One existing causal-verifier role reviews the complete merged candidate, full action and reaction evidence, committed random results, and final temporal state. This replaces component candidate reviews, not plan reviews. Every step receives a bound review, including context-only steps. No model, thinking setting, action cardinality, or repair limit increases. Outcome identity derives from the original action rather than a response-local proposal key, so independently generated names cannot alias the repair owner.

Observation-only findings repair the named observers with the actual finding text. Effect findings resume their owning component sessions with unchanged plans and random commitments. Unknown ownership fails closed. Complete final evidence is reviewed again after every repair. Exhaustion or cancellation leaves the source state unchanged and closes suspended sessions. Accepted review content is bound through the canonical commit boundary; a changed proposal, action, reaction, random result or temporal state invalidates it.

## Plan

Integrate resumable candidates into the step coordinator, add final temporal evidence and targeted observation feedback, and enforce the final content binding in CanonicalCommitter. Pin the changed execution contract and regenerate the algorithm catalog. Keep paid trajectories stopped under the existing admission budget.

## Verification

Exercise the real step entry with controlled model responses: merged observations equal reviewed and committed observations; targeted rejection preserves unrelated components and RNG; rejected or mutated final candidates cannot commit; lifecycle settlement is visible to review; terminal errors are atomic. Run relevant regression tests and check:fast before committing.

## Limits

Exact coverage does not prove model judgment correct. The single full-step review can have different reliability and context cost from component reviews. Context-only steps require a review call; this coverage cost is reported separately. Paid latency, token savings and continuous-play success require an admitted subsequent trial.

## Evidence

[Eager step tests](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts), [candidate session tests](../../src/engine/mechanics/__tests__/truth-candidate-stage.test.ts), and [bound review tests](../../src/engine/mechanics/__tests__/causal-review-stage.test.ts) own execution, continuation, and evidence identity respectively.
