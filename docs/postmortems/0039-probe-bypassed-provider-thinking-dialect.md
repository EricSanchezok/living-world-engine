# Probe Bypassed the Provider Thinking Dialect

Artifact-Version: 1

## Executive summary

An exact-message experiment compared DeepSeek Chat JSON and Responses JSON, but its standalone encoder copied Chat's `thinking` field into Responses. The provider silently ignored that field and enabled thinking. The experiment's intended single-variable comparison was invalid even though all requests had usage and the Responses arm produced more parseable output. No gameplay candidate was promoted from this result.

## Summary

STEP-E1 `probes-e1-json-01` completed twelve requests before a response-evidence review found reasoning output in all six Responses requests. The production DeepSeek dialect already encoded disabled thinking as `reasoning.effort: none`; the defect was duplicated transport logic in the new probe. Its initial test asserted the incorrect field rather than verifying the vendor contract. All costs and original artifacts remain in the experiment ledger, and the experiment report marks the comparison invalid.

## Timeline

- Full-world failures motivated an exact-context JSON transport comparison.
- A standalone probe translated messages correctly but reused the Chat thinking extension.
- Twelve responses passed usage accounting; response correctness varied across arms.
- Inspection found positive reasoning tokens and reasoning items despite the intended disabled setting.
- The probe adopted the production dialect transformation and a per-response inference gate before any further comparison.

## Root cause

The probe bypassed the production provider boundary to preserve exact captured messages, and then duplicated a protocol-specific control mapping. Tests mirrored that mapping. HTTP success and known billing proved transport completion, not that the provider honored the requested controls. Checking those controls only at final analysis allowed all twelve requests to complete under an invalid comparison.

## Guardrails

- [Production dialect](../../src/engine/models/model-dialect.ts) exports the same DeepSeek Responses transformation used by the adapter and exact-message probes; the ignored Chat extension is removed.
- [Probe regression tests](../../scripts/experiments/step-json-probe.test.ts) check the documented wire setting and reject recorded-style positive reasoning tokens, missing evidence and model drift. The probe records and stops at the first response that violates its inference contract.
- [Real gateway matrix](../../src/engine/models/__tests__/model-provider-matrix.test.ts) checks Responses settings through the production gateway.
- [DeepSeek Responses contract](https://api-docs.deepseek.com/api/create-response/) defines `reasoning.effort: none`; unsupported fields cannot establish effective configuration.
