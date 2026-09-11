# Complete Compilation Repair Evidence

Artifact-Version: 1
Status: Approved

## Intent

Repair the feedback boundary under the [authorized gameplay optimization](0029-nonthinking-gameplay-efficiency-experiment.md). A model must receive every independently detectable invalid reference use in its rejected compilation, with paths and values matching the displayed candidate.

## Contract

The compiler collects reference-use failures across a schema-valid slot before materialization. Unexpected implementation errors propagate. Each slot exposes an ordered issues array and its exact previousAttempt. Materialization, temporal eligibility, state assertions and semantic validation remain authoritative; collecting reference errors does not claim to evaluate dependent checks before their inputs are valid.

Representation codecs project schema-owned reference values only when the issue path identifies the same original value in the rejected candidate. Conditional first/rest and named profile selectors receive corresponding wire paths. Literals, unmatched evidence, original action text, successful neighboring slots and root-pinned candidate identities remain intact. Repeated allowed-reference lists may share a hash-bound dictionary across issues with an exact context round trip. Projection and codec identities bind the revised model-visible contract.

No reference is automatically replaced, no condition is deleted, and no repair limit, model or thinking setting is increased. Historical failed trials remain closed. The [integrated gameplay candidate](0067-sparse-canonical-gameplay-candidate.md) requires fresh source/body proofs and whole-world evidence after this shared compiler repair.

## Plan

Verify the feedback at the real compilation gateway, run relevant checks and check:fast, and commit this independent repair. Preserve cumulative costs and unknown reservations before freezing a new trial. Record foundation correctness separately from observed model recovery and gameplay outcomes.

## Verification

Inject simultaneous assertion and dependency reference errors into one slot while retaining a valid neighbor. Require all diagnostics in one bounded repair, exact paths into the displayed rejected candidate, stable aliases, unchanged successful slots and the same canonical result as the valid control. Cover first/rest, named selectors, opaque literals, mismatched evidence and dictionary corruption. Existing temporal and reference validation tests remain required.

## Evidence

[Gateway regression](../../src/engine/algorithms/eager-reference/__tests__/compilation-repair-evidence.test.ts), [representation tests](../../src/engine/algorithms/eager-reference/__tests__/action-compilation-representation.test.ts), and [dictionary tests](../../src/engine/mechanics/__tests__/shared-repair-handles.test.ts) own the deterministic guardrails. The gateway covers reference diagnostics in both valid and malformed physical batches and retained candidates during whole-attempt source-description rejection. [The original incident](../postmortems/0085-incomplete-compilation-repair-evidence.md) and [recovery-path omissions](../postmortems/0116-compilation-recovery-paths-lost-evidence.md) record escaped failures and their limits.
