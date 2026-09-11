# Event-sourced outcome summaries

Artifact-Version: 1
Status: Approved

## Intent

Prevent transition outcome summaries from introducing realized sub-actions that exist nowhere in the candidate world. Preserve arbitrary action semantics and the ability to produce arbitrary supported events and state changes. This opt-in experiment changes generated representation; it is not lossless recovery of an independently authored summary.

## Contract

The indexed reviewed Truth candidate can declare an event-sourced outcome summary contract. Both canonical and indexed physical transition requests retain their complete original context, actions, slot ownership, generation settings, causal assertions, event and operation schemas. Their outcome wire rows omit the free summary field. No additional model call is introduced.

The decoder derives an outcome summary from its explicit status and the descriptions of candidate events in the same logical slot that directly cite that exact source action as a cause. Event order and descriptions are preserved. It never rewrites a subject, infers a completed sub-action from intent, creates an event, or promotes an outcome to success. Events with indirect causes remain in the complete candidate even when they are not repeated in a particular summary. A status without a listed event asserts only the selected status, not that nothing happened or that success has been independently proven.

The model must put any proposed realized communication, dispatch or other semantic occurrence in the existing event or state-change channels with valid causes and assertions. Event descriptions remain open natural language. They undergo the existing deterministic materialization, causal and semantic verification. Merely declaring an event does not prove its truth; temporal plausibility, perception, action ownership and all existing commit checks still apply.

The request lists assertion discriminators and required fields extracted from its actual output schema. It distinguishes Activity scheduling reasons from causal assertion types, checkpoint arrival from completion, and post-operation outcome/event time from an Activity checkpoint timestamp. This clarification introduces no assertion variant or generated evidence.

Unexpected legacy summaries cannot bypass the contract. Invalid rows remain invalid for the existing slot-local validation and bounded repair path. The decoder preserves all other fields; component-level model repair can still change other generated records and requires independent review. Source hashes, schema hash and instruction version bind each request. The default Composition and historical results are unchanged.

## Plan

Implement the wire adapter and source-bound decoder for both existing transition shapes. Exercise original codecs and slot validation, then freeze complete historical-input preflights and a bounded nonthinking diagnostic. Integrate the candidate only after the diagnostic identifies no new semantic regression; full gameplay and independent confirmation remain necessary.

## Verification

Verify direct action ownership, same-slot event ownership, exact event prose/order, empty events, malformed rows, and rejection of a supplied summary. Preserve all context and non-summary fields. Run focused tests and check:fast before commit. Report new event generation, assertion failures, repair drift, tokens and actual HTTP separately; never reclassify a historical failure as passed by reformatting it.

## Evidence

The [adapter](../../src/engine/mechanics/event-outcome-summaries.ts) and [tests](../../src/engine/mechanics/__tests__/event-outcome-summaries.test.ts) own source binding and wire validation. The [decision](../decisions/0146-source-outcome-prose-from-events.md) records the tradeoff.
