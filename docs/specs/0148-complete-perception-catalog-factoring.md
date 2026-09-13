# Complete Perception Catalog Factoring

Artifact-Version: 1
Status: Approved

## Intent

Reuse exact catalog template factoring for the complete single perception request. The failed player source contains 2,158 catalog records occupying 600,621 compact JSON bytes. Planning already uses shared catalog templates; this experiment evaluates the uncovered perception surface independently.

## Contract

Factor equal catalog record fields into templates and retain ordered rows containing each original handle, label and statePath when present. Preserve absent fields, nulls, unknown fields, every candidate, original order and field permissions. Expansion must recover the entire canonical context hash. No fact, action, observer, rule, hidden state or semantic choice is removed or inferred. Canonical output and reference validation continue against the original unencoded request.

## Plan

Reuse the catalog factoring primitive while preserving existing shared-batch bytes. Freeze a B/C/C/B complete-source screen with four HTTP calls, no repair and no continuation. Apply the experimental representation at the physical fetch boundary and save every actual transmitted body separately from the gateway's logical pre-transform request audit. Manifest hashes bind actual request bytes, full producer patch and source identity. The source, output schema, model and disabled-thinking setting remain fixed.

## Verification

Exercise the actual gateway and capture physical requests. Expand the encoded context back to the complete logical request, including duplicate record values, ordering, missing fields, nulls and unknown future fields. Reject changed templates, permissions, source context or output references. Existing shared catalog round-trip regressions must preserve their representation and scopes. Compare measured input/output/cache tokens, initial rejection and elapsed time, including rejected outputs. Independently review observer/source meaning and access; compression alone cannot establish semantic correctness or the complete-player target in [Spec 0122](0122-player-action-efficiency.md).

## Evidence

[Shared catalog records](0059-transition-catalog-records.md) owns the existing multi-slot representation. This single-request experiment adds an ordered catalog table without altering the default runtime. The [relation-domain](0146-perception-check-relation-domains.md) and [visibility-branch](0147-perception-visibility-branch-screen.md) screens remain negative evidence and are not combined with this intervention.
