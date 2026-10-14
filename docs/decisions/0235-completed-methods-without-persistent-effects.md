# Separate performed methods from persistent state changes

## Status
Accepted
Class: architecture

## Context and Problem Statement

An ordinary use/change operation with no quantity, property or random effect was always downgraded to partial progress. Effect selection also combined an existing representation with an attempt having no justified effect. The regression includes ordinary bodily actions that remained unrepresented, followed by prose inventing their completion. An action can instead be fully performed without changing a persistent property, while a posture or temporary use may require a new qualitative property.

## Decision Drivers

- Let common-sense adjudication handle ordinary behavior.
- Preserve the distinction between attempting, performing and achieving an effect.
- Keep new persistent results in the existing extension and commit path.
- Avoid inventing properties or resource changes solely to mark an event complete.

## Considered Options

- Require a persistent delta for every successful physical action.
- Treat every mechanically empty action as successful.
- Select effect representation separately from feasibility and retain a performed-method receipt when both decisions justify it.

## Decision Outcome

Choose the third option under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md). The world decision distinguishes an existing property/procedure, a needed qualitative extension, a newly performed instantaneous method with no continuing state, and an already-established target state. A successful instantaneous-method outcome can produce a completed-method receipt without persistent changes. An already-established state produces a no-repeat receipt instead. Holding, posture and ongoing pressure remain continuing properties even if the wider intended benefit fails. A partial or failed outcome stays partial or failed. An existing-representation choice with no admitted effect remains unconfirmed.

Familiarity does not require a concept to be prewritten: an ordinary posture or temporary relation can enter the reusable capability path. Authored mechanics and actual existing properties continue to take priority. Narrative and perception consume the admitted receipt, while replay uses the saved event without another decision.

## Pros and Cons of the Options

- Requiring a delta gives a simple completion rule but falsely treats harmless completed methods as unfinished and encourages redundant success flags.
- Unconditionally accepting empty effects is permissive but can announce completion when the world could not represent the requested change.
- Separate semantic choices preserve both cases using the current request and event contract. They require accurate adjudication; the deterministic kernel cannot prove the semantic choice correct.

## Links

- [Regression evidence](../research/2026-10-14-conversation-continuity-regressions.md)
- [Narrative and effect boundaries](../game-design/narrative.md)
- [Direct runtime regressions](../../src/engine/direct/__tests__/runtime.test.ts)
