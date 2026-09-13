# Perception admitted unusable check commitments

Artifact-Version: 1

## Executive summary

The standard composition's complete player diagnostic failed after admitting twenty perception checks that later reports could not legally reference. Admission required an assigned Action cause but omitted the Fact/Law cause required by receipt validation. Three terminal generations then tried to repair reports around immutable invalid prerequisites.

## Summary

Execution 81700a77-de47-4ec7-a3a5-50c8a30bee88 used the complete forty-eight NPC world plus one external player. Submission ended after 163.985 seconds with no player feedback or world commit. Check admission was accepted at Ledger sequence 317 after source 305; its public invocation was 81700a77-de47-4ec7-a3a5-50c8a30bee88::rt:model-audit:0fadc800160c4afab9f72b5da15d1db148baa3028a016f5fd3bd6a4c6c140d6f. Every admitted check's causes contained only an Action. The three subsequent terminal reports failed the receipt's observer/source/world-basis dependency condition.

## Timeline

- Initial perception output failed reference validation.
- Its repaired proposal passed assignment, ownership and numeric materialization and fixed twenty random checks without any world Fact/Law cause.
- Terminal sources at sequences 320, 335 and 350 returned mechanically parsed reports, then failed semantic receipt validation at sequences 332, 347 and 362.
- Those three generations consumed 24.256, 19.696 and 20.805 seconds of transport execution. This 64.757-second sum is observed work on unusable prerequisites, not a measured speedup from the fix.
- Ledger doctor found no orphaned artifacts, index gaps or integrity warnings; source checks and the owning validators reproduced the inconsistent admission boundary.

## Root cause

The proposal validator checked the assigned observer and source Action while the terminal validator additionally required a Fact or Law cause on every cited perception check. The stricter downstream contract was introduced without moving its necessary condition into check admission. A later model report could select another check or omit references, but could not add causes to an already fixed check. Treating these as report repair failures concealed the earlier engine mistake.

Some scripted perception fixtures also used Action-only causes. They could complete with no-stimulus reports that did not cite the checks, so their success never exercised the eventual dependency contract. A numeric difficulty source is separately selected and does not populate the explicit causal basis automatically.

## Guardrails

- [Perception relation validation](../../src/engine/contracts/perception-references.ts) rejects an assigned onset check lacking a Fact/Law cause before materialization and RNG. It reports the exact causes path without copying the entire catalog into every issue. Existing source validation still rejects invented references, and the model still owns meaningful evidence selection.
- [Real-entry regressions](../../src/engine/mechanics/__tests__/perception-references.test.ts) reproduce rejection with no continuation and verify that a repaired proposal sees no fixed checks or results, then produces the same commitments and RNG as a clean valid proposal.
- [The receipt contract](../specs/0128-observer-bound-onset-receipts.md) states the admission prerequisite explicitly. Receipt validation remains strict; no rejected check is rewritten and no failed outcome is bypassed.

## Verification

The new real-entry regressions fail on the previous implementation. Run the focused perception checks and complete check:fast before committing, then repeat a separately frozen full player diagnostic. Earlier rejection alone does not establish correct uncertainty selection, successful reports or the sixty-second player goal.
