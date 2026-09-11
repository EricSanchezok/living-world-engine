# Empty Provider Error Blocked Failure Persistence

Artifact-Version: 1

## Executive summary

A no-cost network reproduction received HTTP 401 with an empty SDK error message. The execution Ledger became failed, but the instance run remained running because its terminal update violated the nonempty run-error contract.

## Summary

The diagnostic replayed saved initialization outputs and sent compilation requests without credentials. It never committed a game step. The network results were available, but failure reporting itself could not persist. The STEP-E1 record owns the diagnostic's immutable inputs and results. This is a runtime failure-reporting defect, separate from DNS reliability and model compilation quality.

## Timeline

- Eight recorded initialization responses passed exact request-hash matching through a real WorldHost.
- Four original compilation bodies reached the provider without credentials and received HTTP 401.
- The SDK exposed an empty error message. The execution terminated, but instance validation rejected the empty error field in the failed-run update.
- A real WorldHost regression reproduced the mismatch using a terminal model transport error with an empty message.

## Root cause

The failure handler copied `Error.message` directly to `run.error`. JavaScript permits an empty message, while instance persistence requires nonblank text when that field is present. The handler persisted execution failure before attempting the instance update, so a secondary validation failure left the two records inconsistent. Existing failure tests supplied descriptive messages and did not cover this boundary.

## Guardrails

The [WorldHost failure handler](../../src/server/world-host.ts) retains a nonblank message and otherwise uses the error name or a stable execution-failure fallback. It preserves the original error in the Ledger. The [host regression](../../src/server/__tests__/world-instance-host.test.ts) verifies a durable failed run and failed execution, with the canonical state unchanged, when the model boundary throws an empty-message terminal error.
