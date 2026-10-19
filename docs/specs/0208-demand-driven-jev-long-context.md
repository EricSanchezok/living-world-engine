# Demand-driven Jev long context

Artifact-Version: 1
Status: Implemented

## Intent

Implement the user's explicit approval to use Jev's long-context capability before generative fallback, and compare unchanged recorded gameplay decisions for cost, latency and semantic quality. Preserve natural actions, complete authorized evidence and existing publication/commit validation. After reviewing the failed qualification, the user explicitly selected capability and report delivery while retaining current gameplay routing.

## Contract

- Use the default native context mode when both the full request and shared-state-plus-largest-question estimates fit its limits. A configured long-context capability raises both limits only for a request that exceeds a default token limit; byte and explicit operator input caps remain independent hard limits.
- Budget preflight, memory pressure, recorded request identity and the actual native HTTP header use one selected context plan. Publication budgets measure their own policy, not the world-decision policy. Keep memory's 80% trigger against the selected effective capacity.
- A provider-confirmed default-context overflow may escalate once to long context before the existing full-batch Flash fallback. A long-context overflow or unsupported capacity retains the existing explicit fallback. Do not split questions, truncate state, add a classifier or enable long context for small requests.
- Preserve the same model version, complete question set, cognitive isolation, typed answer validation and canonical transaction gates. Record the selected mode and failed attempts. Historical requests and saves remain immutable.
- Compare previously captured world and publication decisions with provider usage and transport timing. Agreement with the old model is a diagnostic, not a quality oracle: inspect consequential differences against source evidence. Do not claim whole-game speedup from isolated calls or enable an unqualified publication replacement.
- Gameplay quality is an activation condition. If unchanged recorded requests demonstrate material semantic regressions, ship the transport and budget capability without enabling it in the bundled profile; retain the failed evidence and describe the remaining qualification work.

## Plan

Implement a shared admission plan and native transport support with focused regressions. Run paired recorded requests and inspect semantic differences, then run the repository checks and commit the independently verifiable unit. Document further adjudication and publication improvements separately from shipped behavior.

## Verification

Cover both default limits, threshold equality, explicit input/byte caps, long overflow, default-provider overflow escalation, publication-policy measurement, concurrent mixed modes and unchanged complete request bodies. Use real gateway/adapter composition with only HTTP replaced for deterministic tests. Compare saved real requests through the same gateway without changing their state or questions; retain all failures and actual usage. Run check:fast.

## Evidence

The [context budget tests](../../src/engine/models/__tests__/context-budget.test.ts) and [native gateway tests](../../src/engine/models/__tests__/native-context.test.ts) own admission and fallback regression coverage. The [decision](../decisions/0270-demand-driven-native-context.md) records the capacity tradeoff. The [recorded-request comparison](../research/2026-10-19-jev-long-context-qualification.md) records latency, usage, semantic failures and the bundled activation boundary.
