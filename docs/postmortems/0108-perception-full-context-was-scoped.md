# Perception full context was constructed as scoped context

Artifact-Version: 1

## Executive summary

The onset-perception Composition declared full context, but its actual entry omitted workset.mode and the shared builder defaulted to scoped context. The full reference catalog consequently advertised Facts absent from the displayed canonical state. The durable guardrail compares actual initial, repair and continuation requests with the complete source projection.

## Summary

A captured 48-action, 29-pair scene offered 636 Fact references while displaying 414 Fact rows. The missing 222 values were not evidence available to the model, despite their references being selectable. This does not establish that any particular prior model error was caused by the omission, but it invalidates an assumption that those requests contained complete canonical truth. Historical outputs and measurements retain their original scope.

## Timeline

- The registered perception configuration fixed contextMode to full.
- The perception entry built its workset without an explicit mode; the shared default remained scoped.
- Type, reference and numeric tests checked identities and selected cases without comparing the complete runtime projection with the registered contract.
- A snapshot codec's offline completeness assertion rejected a reference absent from the actual request before any new model HTTP.
- Source inspection located the missing mode at the real entry; regression tests cover nonglobal inputs through repair and committed-check continuation.

## Root cause

Declarative algorithm configuration and effective request construction were not linked by an entry-path assertion. The resolver retained a full catalog while scopedCanonicalTruth filtered source records using action/grounding reachability. Tests comparing against the same scoped builder or checking only a subset of fields could not detect the contract mismatch. Four development controls used global groundings, so their source projections were complete and also missed this failure.

## Guardrails

- [Spec 0105](../specs/0105-complete-onset-perception-context.md) owns full perception context, semantic access limits and separate foundation accounting.
- [Real perception tests](../../src/engine/mechanics/__tests__/perception-references.test.ts) compare complete source truth and Fact coverage across actual requests with nonglobal groundings.
- [Snapshot tests](../../src/engine/benchmarks/step-efficiency/__tests__/perception-selection-codec.test.ts) reject missing or altered source rows before model HTTP instead of adding undisplayed values or shrinking the candidate domain.
