# Initial Intent Frontier Screen

Artifact-Version: 1
Status: Approved

## Intent

Expose the structural starting point of an existing intent program to the planner under the [complete-player experiment](0122-player-action-efficiency.md). A complete intended sequence can otherwise be interpreted as work accomplished in the current interval.

## Contract

A benchmark logical provider adds an initial-frontier view to assigned actions with an exact validated intent-program embedding and a unique matching active Activity. Eligibility requires matching action and actor references, Activity start and update times equal to the interval start, a matching plan start, stage index zero, null Activity and plan progress, empty plan stages, and no committed resolution plans or receipts in the workset. Missing temporal evidence is a configuration error for this screen. Noninitial, ambiguous, ordinary-text and malformed-program actions retain their original context without a frontier claim.

The existing program inspector traverses sequence first children and all parallel children, stopping at attempts or conditions. The view copies those nodes and resolves their target ordinals only to their own action's ordered local references. It includes source-action, program, Activity and temporal-evidence hashes. It evaluates no conditions, chooses no branch, creates no execution cursor and infers no completion or elapsed duration. The frontier is an intention starting point, not a cap on effects that source evidence supports during the interval. Later nodes require their preceding work and conditions to be established by adjudication. An Activity checkpoint is not a minimum completion time.

All original context, actions, programs, targets and response contracts remain intact. Removing the additive view restores the exact source. Source or view mutation fails closed. The provider changes no model-call policy, repairs, validators, random commitments or world state. Runtime Composition registration remains unchanged.

## Plan

Exercise the real Truth Engine and physical gateway with controlled responses before freezing paired fresh first-planning calls. Both arms retain the same complete forty-nine-action source and canonical-target planning representation; only the candidate includes the structural view and its instruction. Stop before verifier, randomness and commit. Count every call and failure without repair or resampling.

## Verification

Verify nested control flow, unevaluated conditions, exact action-local target ownership, opaque text, initial-state eligibility, ambiguous Activities, source restoration and mutation rejection. Check original canonical admission and rejection through the real entry path. Run relevant checks and check:fast before committing the producer. Require mechanical and independent whole-plan semantic qualification before a full forty-nine-subject diagnostic; a narrow source screen is not completed gameplay.

## Evidence

[Decision 0216](../decisions/0216-expose-initial-intent-frontiers.md) owns the alternatives. [Frontier tests](../../src/engine/benchmarks/step-efficiency/initial-intent-frontier.test.ts) own the execution-boundary evidence.
