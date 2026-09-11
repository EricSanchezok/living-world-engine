# Gateway Audit Discarded Schema Fields

Artifact-Version: 1

## Executive summary

The gateway retained an adapter's schema error as a nested cause but recorded only a generic issue in its audit. Semantic repair preferred that audit and lost the concrete field errors.

## Summary

STEP-E1 trajectory 11 exposed this defect on direct resolution calls as well as batch paths. Its terminating component first rejected invalid causal-reference kinds, then produced other errors during bounded repair and ultimately failed effect consistency. Missing first-repair evidence is established; it is not proof that precise feedback alone would have prevented the final failure.

## Timeline

The original wrapped-error regression checked the classification helper, which correctly recovered the Zod paths. Full-game evidence still recorded empty repair paths. Extending the regression through the actual gateway audit and semantic repair loop reproduced the loss between classification and the second request.

## Root cause

The gateway output-failure branch constructed an audit issue from the wrapper's name and message. The semantic repair loop intentionally prefers provider audit metadata, overriding the correctly classified nested cause. Fixing only the classifier could not correct the live request.

## Guardrails

The [gateway](../../src/engine/models/model-gateway.ts) uses the shared [validation issue classifier](../../src/engine/contracts/prompts.ts) when recording adapter output failures. Field paths, precise codes and available reference metadata are preserved alongside the untouched raw output and exception cause. The existing rule that genuine provider semantic issues take precedence remains intact.

The [gateway regression](../../src/engine/models/__tests__/model-provider.test.ts) runs a malformed provider response through the adapter, gateway and semantic repair loop, and checks the issue payload received by the second request. A second valid response succeeds in exactly two requests with both audits retained. The provider matrix and logical-slot coordinator regressions cover the adjacent paths.
