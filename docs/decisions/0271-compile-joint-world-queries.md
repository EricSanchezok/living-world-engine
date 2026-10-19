# Compile joint world queries

## Status
Proposed
Class: architecture

## Context and Problem Statement

World adjudication repeatedly selects applicability and an amount whose value is ignored when the rule is inactive. Event delivery and actor visibility separately interpret the same physical event for the same recipient. Large resource catalogs inflate the question set even when most rules have no effect. Removing natural-language rules without a proven scope would change open world semantics.

## Decision Drivers

- Reduce redundant decisions without omitting rules, candidates or unknown states.
- Preserve hearing, sight, identity and private cognition as distinct judgments.
- Keep existing dispatch, repair, fallback, materialization and commit authority.
- Retain reconstructable logical and physical evidence and comparable real-turn costs.

## Considered Options

1. Compile owner-declared conditional and product queries in the existing batch.
2. Ask a preliminary model to select relevant rules and perception cases.
3. Filter rules by action keywords or a fixed shortlist.
4. Keep every conditional question independent.

## Decision Outcome

The approved [query-plan contract](../specs/0209-world-rule-query-plans.md) selects option 1 for implementation and qualification. Resource queries encode the active amount or an inactive/unknown branch; perception queries retain the full Cartesian product. Unrelated and open semantic questions remain in the same complete batch. The compiler derives no semantic rule scope.

## Pros and Cons of the Options

Owner-declared composition avoids another model round trip and has a checkable mapping to every effective original result. It changes the model-visible decision representation and therefore still requires semantic qualification. A preliminary model adds latency and a new omission failure. Keyword filtering cannot establish that an open action is unaffected by an omitted rule. Independent conditional questions retain simple schemas but ask the model to fill unused branches and repeat physical interpretation. Product domains can grow; an oversized complete product retains its original questions.

## Links

- [Observed large resource batches and model-quality failures](../research/2026-10-19-jev-long-context-qualification.md).
- [Direct world runtime](../game-design/direct-runtime.md).
