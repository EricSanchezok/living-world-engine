# Repeat Exact Repair Reference Witnesses

## Status
Accepted
Class: testing

## Context and Problem Statement

A rejected plan may name an irrelevant target and select another entity's meter. More precise diagnostics can describe that rejected target without making the ownership of a newly selected target easy to see. Direct canonical references alone did not eliminate this observed failure.

## Decision Drivers

- Preserve the complete source, semantic freedom and validator authority.
- Expose exact ownership and explicit empty domains near the response boundary.
- Avoid selecting the intended effect subject deterministically.
- Measure a bounded input-layout change before integration.

## Considered Options

- Force the effect target to the selected meter's owner.
- Replace invalid meter effects with conditions automatically.
- Restrict the entire output to a smaller target universe.
- Repeat exact reference records and ownership joins after the schema.

## Decision Outcome

Use the isolated [repair reference witness screen](../specs/0167-repair-reference-witness-screen.md). It repeats source evidence and a general ownership instruction without interpreting the action or modifying any model output. Canonical-reference baseline and candidate share the same complete source and output contract.

## Pros and Cons of the Options

Automatic retargeting and effect conversion can make an invalid plan mechanically legal while changing its meaning. Restricting targets can exclude legitimate affected entities. Repeating evidence preserves those choices and makes absent meters explicit, at the cost of extra input and a possible salience bias toward the rejected candidate's references. Only a fresh paired trial and independent semantic review can assess that tradeoff.

## Links

- [Meter repair evidence regression](../postmortems/0140-meter-repair-lost-ownership-evidence.md).
- [Existing physical contract tail](../specs/0090-registered-planning-contract-tail.md).
