# Preserve Initial Review Evidence Only with Proven Wire Equivalence

## Status

Accepted
Class: testing

## Context and Problem Statement

The integrated-game launcher rejects a previously successful plan-review diagnostic after the physical batching version changes for slot-local repairs. Logical requests, source labels and model settings remain identical. Inspection finds only the local prompt-version suffix differs; a real gateway capture also reproduces the historical first HTTP body. The diagnostic accepted only first-response accuracy and used no repairs.

## Decision Drivers

- Keep empirical qualifications bound to the actual evaluated input.
- Avoid paying to repeat an unchanged initial request solely because local metadata changed.
- Preserve new evaluation requirements for changed repair behavior and final-step review.
- Keep historical results and budgets immutable and derived qualifications traceable.

## Considered Options

1. Require a new paid diagnostic whenever any request metadata changes.
2. Ignore batching version differences in all diagnostic comparisons.
3. Admit one named metadata transition only with complete first-request wire equivalence and unchanged first-response scoring.

## Decision Outcome

Choose option 3. Compare all frozen fields, bind both physical request records to their original hashes, allow only the named suffix transition, and render the current request at the real gateway's offline fetch boundary. Require the complete historical HTTP body and request identity to match. Store a first-response-only proof with both request hashes and the common body hash in candidate metadata. No historical report is changed.

## Pros and Cons of the Options

- Option 1 is conservative but requires new spend without a model-visible difference; it does not itself test the changed repair path.
- Option 2 is simple but could transfer a qualification across changed prompts, contexts, schemas or model settings.
- Option 3 preserves the relevant initial-response evidence with explicit boundaries. It adds preparation work and intentionally rejects unrecognized changes, even if they might also be equivalent.

## Links

- [Initial-review equivalence spec](../specs/0076-initial-review-wire-equivalence.md)
- [Slot-local repair batching spec](../specs/0070-slot-local-repair-batching.md)
- [Integrated launcher](../../scripts/operations/step-indexed-checkpoint-playtest.ts)
