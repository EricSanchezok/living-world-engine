# Select complete finite factor choices

## Status

Accepted
Class: simplification

## Context and Problem Statement

The factor-type representation combines authority and role while some alternatives still require a separate direction and authored magnitude. A prospective full-world response selected twenty control factors but omitted every direction. Instructions and schema property ordering did not cause the model to emit governing choices first.

## Decision Drivers

- Preserve every valid canonical factor, including both directions and authored magnitudes.
- Make each generated selection complete without guessing omitted intent.
- Preserve sources, rationale, channels and mechanical source ownership.
- Measure an opt-in representation before changing runtime defaults.

## Considered Options

1. Encode the complete finite product of type, direction and required magnitude in one explicit factor choice.
2. Retain separate direction and magnitude fields with more ordering instructions.
3. Infer missing directions or treat incomplete numeric factors as nonnumeric notes.

## Decision Outcome

The experiment compiles finite products from the existing factor wire schema and restores exactly the explicitly selected tuple. Nonnumeric types retain their semantics. Unknown, truncated and mixed choices remain invalid, and original source authority and canonical validation remain authoritative. The [player action efficiency spec](../specs/0122-player-action-efficiency.md) owns prospective admission; the experiment does not promote this representation to runtime defaults.

## Pros and Cons of the Options

1. All legal combinations remain representable with exact round trips, and the model cannot select a valid numeric choice without selecting its direction. Choice names are longer, and structural completeness does not establish correct semantic use.
2. The interface retains an omission opportunity across fields. The recorded ordering screen did not realize the intended generated order, so it provides no evidence of a working ordering intervention.
3. A deterministic guess can reverse a penalty or remove its influence, violating the explicit semantic choice boundary.

## Links

- [Factor-type decision](0129-select-resolution-factor-types.md).
- [Complete factor product codec](../../src/engine/benchmarks/step-efficiency/factor-choice-products.ts).
- [Domain and rejection regressions](../../src/engine/benchmarks/step-efficiency/factor-choice-products.test.ts).
