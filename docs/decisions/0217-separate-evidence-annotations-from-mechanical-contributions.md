# Separate evidence annotations from mechanical contributions

## Status

Accepted
Class: architecture

## Context and Problem Statement

Permission and risk factors explain source relevance with neutral direction and zero numeric steps. Treating these explanations as exclusive mechanical assignments rejects a fact used to explain both feasibility and danger, even though the numeric computation receives no duplicated contribution. Secondary factors also have zero steps but authorize an additional effect. All factor references can consume finite-use Conditions and enter Agent-visible receipts, so discarding zero-step factors would change more than display text.

## Decision Drivers

- Preserve arbitrary supported intentions and their exact evidence explanations.
- Keep numerical contributions and secondary-effect authorization exclusive.
- Preserve finite-use resource consumption, cognitive visibility and replay.
- Reduce representation-induced rejection without guessing a model-owned decision.

## Considered Options

1. Classify permission and risk as reusable evidence annotations with one entry per source and role.
2. Keep every factor mechanically exclusive and add more corrective instructions.
3. Deduplicate conflicting factors or move their explanations into means automatically.
4. Permit every zero-step factor to reuse a mechanical source.

## Decision Outcome

The kernel distinguishes evidence annotations from mechanical contributions by the existing factor role. Permission and risk can cite a source already used mechanically and can coexist for the same source; repeated source-role annotations remain invalid. Secondary authorization remains exclusive with numeric contributions. Accepted factor records, condition-source collection and cognitive projections remain intact. [Spec 0171](../specs/0171-evidence-annotation-source-ownership.md) owns the full contract and execution versions.

The distinction draws a design analogy from Girard's separation of reusable situations and resource-changing actions. This kernel does not implement linear logic or inherit its formal guarantees. An annotation can still cite a finite-use Condition, so the existing receipt-level consumption remains explicit and unchanged.

## Pros and Cons of the Options

1. Explicit classification preserves the model's supported distinctions without extra inference or numerical double counting. It deliberately expands the accepted annotation combinations and requires lifecycle and cognition verification beyond arithmetic tests.
2. Repeated instructions preserve the acceptance set but require the model to discard a natural evidence classification that has no extra numerical contribution.
3. Automatic cleanup chooses which interpretation to retain, can hide an actual error and can change finite-use Condition consumption or visible evidence.
4. Treating every zero-step factor as reusable overlooks the secondary role's authority to produce an additional effect.

## Links

- [Resolution kernel](../../src/engine/mechanics/resolution.ts).
- [Trusted receipt application](../../src/engine/mechanics/rule-package.ts).
- [Agent receipt projection](../../src/engine/cognition/agent-perspective.ts).
- [Precommitted plans and deterministic effect bands](0067-open-semantic-resolution-plans.md).
- [Historical source-exclusivity diagnostic](../postmortems/0082-hidden-mechanical-source-exclusivity.md).
- [Girard, Linear Logic: Its Syntax and Semantics, sections 1.1.1–1.1.2](https://girard.perso.math.cnrs.fr/Synsem.pdf): distinguishes repeatable premises from resource-changing actions and explains why one resource does not authorize two independent consumptions.
