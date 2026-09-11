# Perception commitment progress probe

Artifact-Version: 1
Status: Approved

## Intent

Test whether a source-bound progress reminder prevents repeated perception commitments under the [authorized non-thinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md).

## Contract

The benchmark-only adapter leaves initial HTTP bodies unchanged and binds every round to one candidate prompt identity. After committed perception checks exist, it appends exact check and result copies grouped by the existing observer/source-action assignments, bound to the complete source context hash. The entire original context, schema, generation parameters and output validation remain authoritative. Missing, duplicate or mismatched result identities fail before dispatch.

The reminder distinguishes a failed random result from unfinished model work. It discourages rerolling the same uncertainty while allowing genuinely distinct necessary questions for the same observer and action. It neither equates all questions for one pair nor terminates the engine loop mechanically. It does not turn a failed check into success, assert that an observer has perceived an action, erase prior commitments or certify the original perceptual route.

The candidate is not registered or selected by game defaults. Prospective comparisons freeze source snapshots, committed RNG results, generation settings, order, cost ceilings and semantic review before model calls. Completion-rate or token changes alone cannot admit the candidate to gameplay.

## Plan

Expose a request adapter, prove the actual gateway continuation preserves full evidence, and compare its next decisions against the original continuation on frozen recorded inputs. Any full-stage follow-up preserves the real commitment loop and includes all calls and source-bound semantic checks.

## Verification

The initial model input is identical; continuation preserves the same context and schema, copies the exact matched request/result, exposes failed outcomes without rerolling, and rejects missing or duplicate bindings. The whole stage retains one auditable candidate prompt identity. The source world remains unchanged. Run focused checks and check:fast before committing.

## Evidence

The [gateway regression](../../src/engine/benchmarks/step-efficiency/perception-commitment-progress.test.ts) owns request delivery and source-state binding. This is prompt-delivery evidence, not measured model convergence.

The design borrows the distinction between a repeated logical operation and a new intent from [Amazon's idempotent API discussion](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). Unlike that service-side protocol, the adapter does not deduplicate requests or provide exactly-once guarantees; similarity of model-authored questions is insufficient for that claim.
