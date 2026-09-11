# Travel Distance Authorized an Action Duration

Artifact-Version: 1

## Executive summary

A travel-time expression describing a location was accepted as exact action duration. Schema, eligibility and temporal materialization shared that extraction, so a twelve-hour plan could pass all formal checks without twelve-hour work in the source.

## Summary

STEP-E2 `probes-e2-source-owned-01` compiled all five twelve-action roots on their first HTTP request. Source-bound review found a definite failure outside its thirteen compound-task exclusions: Sigrun's instruction to stop at a location half a day's travel from Blackoak was materialized with an explicit duration of 43,200 seconds. The trial remains formally successful but fails semantic admission. It committed no game state.

## Timeline

Code `fa3131e` ran the frozen probe through the production compiler and ModelGateway. HTTP 004 compiled source 2. Its action `rt:action:eb6eec6c162d8a08fd314a6420e1a49e571eed460174b65c20b720a610d7143d` preserved the original description but selected `explicit-duration` with source text `半天`. Source 2, the HTTP evidence and all 48 original-action review records are indexed in the STEP-E2 execution record and local `v2/runs/probes-e2-source-owned-01/analysis.json`.

## Root cause

The numeric-unit extractor recognized the substring and ignored its travel-distance suffix. Exact text containment established provenance, not the relation between that quantity and the current action. The [deadline guardrail](0058-deadline-authorized-exact-action-duration.md) excluded upper bounds but did not cover spatial descriptions. Formal validators repeating the same extraction could not provide independent semantic assurance.

## Guardrails

The [temporal evidence extractor](../../src/engine/mechanics/temporal-evidence.ts) excludes recognized Chinese travel-distance suffixes and English travel-time location expressions. The [temporal kernel regressions](../../src/engine/mechanics/__tests__/temporal.test.ts) cover the recorded source across eligibility and both materializers, retain positive travel-duration controls, and preserve exact offsets for a genuine rest interval in a mixed location-and-action sentence. This bounded lexical guard does not interpret arbitrary time language, actor ownership, quotations or future scheduling; source-bound trajectory review remains necessary.
