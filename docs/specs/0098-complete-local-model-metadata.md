# Complete local model metadata

Artifact-Version: 1
Status: Approved

## Intent

An explicitly selected, documented model must not depend on the remote metadata directory having indexed its release. This supports the authorized provider replacement experiment through the existing trusted local catalog without automatic aliases or extra capability probes.

## Contract

An unknown model key in local model_overrides defines a model only when every supported metadata field is explicitly supplied, including disabled state, name, family, reasoning capabilities, effort values, tool and structured output flags, temperature, dates, modalities, and positive context and output limits. Partial unknown overrides fail. Local definitions do not supply reasoning budgets or active remote status; these remain null and explicit unsupported requirements fail normally.

The normalized snapshot attributes all such model fields to local-override and binds them to the catalog and metadata hashes. Local-only definitions are eligible for exact selectors, never latest-compatible selectors. A later remote listing may supply the model identity while explicit local overrides continue to own their fields; historical snapshots remain immutable. Account endpoints, credentials, driver choice, and exact request/response validation retain their current contracts. Models.dev remains the only runtime remote metadata source, and an invalid or unavailable source retains the existing refresh behavior.

## Plan

Reuse the catalog's existing metadata override schema to require a complete local definition when the remote provider has no matching model. Normalize through the same capability and inference checks, record local field provenance, and exclude locally defined identities from automatic selection. The remote provider itself must still exist.

## Verification

Use the real registry refresh and snapshot persistence path to verify complete local exact selection, rejection of each missing or invalid field, compatibility and disabled-state enforcement, no effect on latest selectors, immutable replay after the directory catches up, and unchanged trusted transport destinations. Run focused gateway and registry tests plus check:fast before committing. Provider availability requires a separate actual request; metadata alone never certifies it.

## Evidence

The [registry implementation](../../src/engine/models/model-registry.ts) and its tests own the validation evidence. [The provider cohort contract](0097-provider-model-cohort-accounting.md) governs the consuming experiment. This extends the local override boundary in [the dynamic registry contract](0008-dynamic-model-provider-registry.md).
