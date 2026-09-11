# Additional Experiment Budget Tranches

Artifact-Version: 1
Status: Approved

## Intent

Resume the user's autonomous gameplay experiment after an explicit additional CNY1000 authorization. Record the user-reported historical CNY300 separately from request-level tariff estimates; a reported aggregate does not establish individual usage or resolve unknown requests.

## Contract

Append an explicit authorization to the existing checksummed journal, binding a unique grant identity, evidence hash, positive safe amount and exact prior exposure. Require a drained writer and explicit quarantine of any historical unknown usage. Preserve all original policy bytes, requests, prices, usage, holds and closed trials.

The cumulative authorization ceiling increases by the grant amount, but future requests are independently bounded by the latest grant alone. Unused historical allocations and later historical settlements or tariff reviews cannot enlarge the new tranche. Existing phase, HTTP, token, per-request and full-run limits remain enforced. Reallocation is a separate prospective entry and must cover incurred exposure. Replaying the journal must reconstruct the same grant boundary and remaining funds; repeated identity or evidence is rejected.

The actual user authorization and reported account aggregate stay in ignored local evidence and the existing private work record. Neither changes model behavior, thinking settings, context scope or gameplay acceptance. Fresh trajectory and independent confirmation retain their complete CNY150 caps and semantic checks.

## Plan

Extend the existing budget with an explicit tranche entry and independent current-tranche accounting, test replay and exhaustion, run check:fast and commit. Freeze the user authorization and prior journal hash locally, dry-run on a copy, then append the same grant and prospective allocations under the existing writer lock. Prepare the committed candidate and start a fresh trial only after complete trajectory and confirmation admission.

## Verification

Test prefix preservation, unknown holds, grant-only exhaustion, historical refunds, duplicate authorization, active or unresolved requests, invalid amounts, wrong exposure binding and tampered replay. Verify phase limits survive renewal and a later grant does not silently stack unused prior money. Preserve real transport reservation-before-send enforcement and all gameplay gates.

## Evidence

[Budget tests](../../src/engine/benchmarks/action-compilation/experiment-budget.test.ts) exercise the journal and actual admission. [Decision 0144](../decisions/0144-independent-budget-renewal.md) records why new authorization is separate from historical valuation.
