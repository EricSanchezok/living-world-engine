# Incomplete Compilation Repair Evidence

Artifact-Version: 1

## Executive summary

A full-world step exhausted compilation repairs before reaching truth resolution. The rejected action used an Agent reference as both an assertion entity and a conflict dependency. Repair fixed the assertion but retained the dependency error that the request had not reported.

## Summary

Strict validation prevented an invalid commit, but incomplete diagnostic projection spent the bounded repair allowance on sequentially revealed errors. The Ledger preserved the rejected candidates and source snapshot, enabling an offline reproduction without another paid request.

## Timeline

- An initial placement assertion was false at action onset.
- The first repair introduced two independent disallowed uses of the same Agent reference.
- Validation threw at the assertion; its diagnostic had no exact field path. The feedback value stayed in canonical candidate notation while the rejected output used request aliases.
- The second repair corrected that assertion reference and retained the unreported dependency error. The whole step rolled back with no committed progress.
- Inspection found a second loss: the context projector retained only the first issue even when validation supplied several.

## Root cause

An audit traversal resolved all reference fields but recorded failures only for inspection. The execution path subsequently threw at the first materialization failure. Assertion paths were incomplete, and the context projector selected one issue. The temporal representation transformed candidate arrays into first/rest without transforming diagnostic paths. Earlier tests covered individual repairs and stable candidates without combining multiple invalid uses in one slot at the actual gateway.

## Guardrails

The [repair contract](../specs/0068-complete-compilation-repair-evidence.md) makes the audit traversal's independently detectable reference failures executable repair evidence. Complete issue arrays retain ordering, and codecs bind paths and schema-owned values to the displayed previous attempt. The [gateway test](../../src/engine/algorithms/eager-reference/__tests__/compilation-repair-evidence.test.ts) verifies three simultaneous failures, a preserved valid neighbor, singleton repair and canonical output equality.

## Limits

The faulty response also changed the placement assertion to null; resolving reference errors does not establish that the remaining state assertion is true. Dependent temporal or semantic failures can still appear after reference repair. No historical request is retroactively counted as successful, and deterministic feedback correctness is not evidence of continuous playable steps.
