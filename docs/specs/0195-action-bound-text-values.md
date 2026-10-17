# Action-bound text property values

Artifact-Version: 1
Status: Approved

## Intent

An executed edit stores the actual resulting document or qualitative state, rather than a description of how to edit it. Existing text values that cannot be selected from the finite decision catalog need concrete, action-bound candidates. Reusable capabilities must not retain those particular values. This scope preserves open actions, cognition boundaries, atomic commits and complete world adjudication.

## Contract

Only existing text properties selected as `new_value` enter this boundary. One creation request proposes exactly one complete replacement value for each selected property; an empty value requires an actual edit that clears its complete text. It receives the existing values and meanings, the bound action, world rules, and the acting subject's private evidence and retained interactions. Other subjects' cognition and unrelated canonical facts are absent. Existing content is supplied as the state being edited, not as permission to reveal hidden information or invent knowledge. Authored text must use actual words, known observations or explicitly attributed claims; unavailable readings stay unknown.

An append preserves valid existing content. A requested correction, deletion or replacement may change that content according to the actual intent and evidence. A proposal such as “record written” or “retain the original and add results” does not constitute document content. The complete world decision batch reviews each candidate for the requested meaning, evidence, access and preservation requirements before any `set_fact`. A rejected candidate blocks that action's effects and does not silently become a placeholder or successful write.

Candidates belong only to the current prepared action and are never added to the reusable capability catalog. A cached capability cannot overwrite an accepted explicit value for the same property. When the same action also requires a new concept, its reusable declaration and the existing-property candidates share one creation request; the declaration excludes those bound values. Existing Boolean, entity, numeric, quantity and random-procedure paths retain their contracts.

Prepared actions retain a required `propertyVisibility` array binding each candidate's original and proposed value hashes to their separate perceptual verdicts. Both verdicts are explicit questions in the same supplemental batch: the original-value question concerns an attempt without a committed replacement. Settlement selects the verdict for the value actually committed, or the original value when the operation fails; neither question can reveal a different value through a shared fact identity. Accepted replacements use the ordinary changed-fact description so observations and belief descriptions express the actual resulting text.

The normal creation and supplemental decision call count and batch grouping remain unchanged. Structural repair remains bounded. More evidence increases input size; no speed or token reduction is claimed. The direct producer advances to version 11 and its control state to version 4. Execution contract 14 and instance schema 32 remain unchanged. Incompatible local instances are preserved outside the active data root and are not migrated.

## Plan

Separate concrete property-value generation from reusable capability admission, use the acting subject's existing private view for evidence, review candidates in the existing world batch, and give accepted existing-property decisions precedence over reusable effects. Retain authorization rejection filters. Add real gateway and simulation-entry regressions before live qualification.

## Verification

Exercise real HTTP serialization and simulation commits with only the expensive model boundary replaced: concrete document text and observations, append preserving old content, a second edit using new content rather than a cached first result, an explicit selection equal to the current value, deliberate deletion, unknown information isolation, rejection of placeholder content, mixed concept and value creation in one call, and unaffected non-text effects. Verify old/new visibility independently on success, rejection and a settlement resource conflict. Compare transport call counts and replay the resulting state. Repeat the recorded fleet write with the real model and inspect actual candidate and admitted operations.

## Evidence

The [placeholder-write postmortem](../postmortems/0176-document-writes-became-reusable-placeholders.md) owns the recorded failure, world-only comparison and escaped-test analysis. [Gateway and simulation-entry regressions](../../src/engine/direct/__tests__/property-values.test.ts) verify concrete contents, later edits, clearing, private evidence, observation descriptions, value-bound visibility and final settlement conflicts. [Existing qualitative-property tests](../../src/engine/direct/__tests__/runtime.test.ts) retain their actual committed-value and observation assertions. These deterministic tests verify the engine boundary; real-model gameplay qualification remains separate.
