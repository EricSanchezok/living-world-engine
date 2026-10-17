# Repeated observation with multiple exact aliases

Artifact-Version: 1

## Executive summary

A second ordinary observation failed when the observer already knew the same place under two valid local identities. Perception treated multiple exact bindings as if no usable identity existed, generated another stable alias, and later tried to introduce that alias again. The kernel correctly rejected the duplicate; perception now deterministically reuses an existing exact alias.

## Summary

An original merchant identity knew its opening place through both a location alias and an opening-place alias. After resting, looking out of the window reached a canonical observation validation failure. The immutable Ledger retained the rejected observation and rollback; no duplicate identity committed. A separate natural-dawn session hit the same error, so that session could not establish whether its calendar request worked.

## Timeline

1. Origin initialization permitted multiple local names for one exactly known canonical entity.
2. The first observation created a stable generated alias despite the two existing exact aliases.
3. The next observation attempted to introduce that same generated alias again. Canonical validation rejected the transaction and stopped the foreground run.
4. Binding and observation inspection identified three exact bindings, rather than one ambiguous binding with several candidate identities.
5. A real-engine regression reproduced repeated observation with multiple exact aliases and retained an unrelated ambiguous binding.

## Root cause

The alias lookup required exactly one matching binding before reusing a local entity. That condition confused multiple established names for one entity with uncertainty about which entity a name denotes. When several exact bindings existed, the fallback generated a deterministic alias whose identity did not change on later calls. The second introduction collided with the first. Tests covered familiar and unfamiliar entities individually but did not combine repeated perception with legitimate many-to-one local identity bindings.

## Guardrails

[Perception](../../src/engine/direct/perception.ts) chooses a stable existing local entity from exact single-candidate bindings. It does not merge or resolve uncertain multi-candidate bindings. [The runtime regression](../../src/engine/direct/__tests__/runtime.test.ts) uses the actual simulation entry path, performs repeated observations, verifies that no extra identity is introduced, preserves the ambiguous binding, and checks committed-state replay equivalence. The canonical duplicate-introduction check remains unchanged.
