# Keep memory amortization at hard capacity

## Status

Accepted
Class: bug-fix

## Context and Problem Statement

A request can exceed capacity because of its shared task, candidate set or protected records while the actor has only a tiny eligible history prefix. Full-request pressure does not establish that rewriting that prefix can make useful room. Actual play repeatedly attempted to summarize one or two episodes, retained their exact details and failed the required reduction check. A new episode changed the source hash and admitted another costly attempt.

## Decision Drivers

- Preserve original evidence, protected records and complete decision semantics.
- Avoid ineffective work that delays a foreground request without relieving its actual pressure.
- Keep useful hard-capacity compaction and newer-checkpoint rebuilding available.
- Use the existing admission measurements and persistence contract.

## Considered Options

- Bypass history amortization whenever the complete request reaches capacity.
- Apply the existing useful-prefix threshold at every pressure level.
- Predict the exact reduction needed from each actor and retry any prefix that could theoretically fit.

## Decision Outcome

Apply the existing useful-prefix threshold at every pressure level. At least 2,048 heuristic tokens of eligible new records and enough to amortize the prior summary plus protected records are required. Hard pressure waits for admitted useful work, rebuilds after a newer checkpoint and otherwise returns the existing explicit capacity failure. Existing configured model fallback remains available; no important history is deleted or silently omitted.

## Pros and Cons of the Options

The unconditional bypass can recover from a small near-limit request, but also schedules work when non-memory content owns the pressure and the new prefix contains almost nothing disposable. It caused repeated failed work during real play.

A common admission threshold is deterministic across restart and preserves the existing successful substantial-prefix path. It deliberately gives up speculative compression of tiny prefixes at a hard limit. Such a request can fail earlier, while retaining its original context and using the existing fallback policy.

Predicting exact relief could admit some useful small prefixes, but aggregate calibrated request estimates do not identify each actor's marginal token contribution, and the exact protected output is not known before generation. An optimistic estimate would not establish that the model can actually reduce the retained record. That added mechanism is not justified by the observed failure.

## Links

- [Memory contract](../game-design/agent-memory.md)
- [Approved scope](../specs/0203-narrative-evidence-and-useful-memory-admission.md)
- [Actual-play failure and guardrails](../postmortems/0179-speech-premises-local-time-and-ineffective-memory.md)
- [Memory service regression](../../src/server/__tests__/agent-memory.test.ts)
