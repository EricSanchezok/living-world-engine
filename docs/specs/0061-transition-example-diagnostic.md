# Transition Example Diagnostic

Artifact-Version: 1
Status: Approved

## Intent

Under the user's delegated optimization scope in [0029](0029-nonthinking-gameplay-efficiency-experiment.md), test whether a schema-derived empty example conflicts with complete transition repair. A raw failure identical to the illustrative example motivates a controlled comparison, not a causal conclusion.

## Contract

The isolated diagnostic compares the same complete historical logical repair request with its existing example and with the existing `jsonExamplePolicy: omit` option. Both arms retain the same state, twenty-four source actions, latest rejected candidate, four validation errors, canonical schema, inference settings and reference scope. The only wire difference is removal of the illustrative example block. Neither arm consumes the other's output or extends a gameplay repair loop. Each arm makes one new HTTP request without automatic retries; historical failures remain closed.

The prospective manifest freezes the order, complete body hashes, tokenizer admission, current commit, two-request worst-case budget and original candidate/state hashes. Known usage and unresolved billing remain in the existing ledger. The full pair must fit before dispatch. Interruption, unknown billing or inference drift stops further sends and writes partial results. Formal failure is a measured arm result; it cannot bypass semantic or transaction checks.

## Plan

Reuse the historical candidate preparation, real gateway, strict transport and cost ledger. Record each full request and response independently. The treatment is eligible for source inspection only if it restores complete schema, action and reference coverage; a single pair does not establish general reliability or authorize a gameplay-success claim. Runtime selection requires a separately frozen integration.

## Verification

Prove through offline real-gateway rendering that the control exactly matches the recorded request and removing only the example block gives the treatment byte-for-byte. Run the existing gateway policy tests and check:fast before committing. Verify both arms retain disabled thinking and no network retries.

## Evidence

The [diagnostic runner](../../scripts/experiments/step-transition-example-probe.ts) owns source and complete-wire checks. [Gateway tests](../../src/engine/models/__tests__/model-provider.test.ts) own example omission and audit evidence. [Coverage scoring](../../src/engine/benchmarks/step-efficiency/repair-tail.ts) rejects empty outcomes independently of schema parsing.
