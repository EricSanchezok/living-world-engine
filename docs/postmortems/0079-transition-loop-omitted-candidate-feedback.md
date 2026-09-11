# Transition Loop Omitted Candidate Feedback

Artifact-Version: 1

## Executive summary

A full-world diagnostic reached transition validation but rolled back after an unknown fact reference and unsuccessful logical repairs. The custom transition loop omitted the latest rejected draft, although the shared Truth repair loop already implemented that contract. The next model response returned empty outcome arrays for a component with twenty-four assigned actions.

## Summary

The run preserved revision zero and completed all fifty-nine HTTP requests with known usage. Its large indexed transition covered the physical action batch but contained an invented existing-fact handle in one component. Reference validation correctly rejected that component. The following logical request included the error and catalog but no previousOutput or candidate binding. Regeneration then lost required outcome coverage; further bounded repair did not recover it. No validation rule should be relaxed to make this run pass.

## Timeline

- The shared logical repair loop gained candidate feedback under [specification 0037](../specs/0037-truth-rejected-candidate-repair.md).
- The transition stage retained a separate loop for mechanic repair, observation generation and causal review.
- An integrated gameplay diagnostic passed earlier stages and exposed an unknown fact reference in a twenty-four-action transition component.
- Inspection of the actual next request showed that its source/error context omitted the draft it needed to repair.
- The transition loop adopted the existing logical repair context and candidate-lifetime rules; the original failed evidence remained immutable.

## Root cause

The implementation attached candidate evidence inside the common generation helper. The custom transition loop called the provider directly, so it continued rebuilding requests from source and issues alone. Tests covered mechanic-specific repair and observation-specific repair, but did not check candidate continuity across ordinary transition retries. A reference failure therefore required a full regeneration without the draft containing that reference. The observed empty response is a model result, not a deterministic consequence or proof that adding feedback will make the real model succeed.

## Guardrails

- [Real-step transition repair tests](../../src/engine/mechanics/__tests__/transition-candidate-repair.test.ts) cover post-generation rejection, malformed provider output, unavailable-output clearing, explicit null, exact source/candidate/invocation bindings and replayed state.
- [Logical repair context](../../src/engine/prompts/logical-repair-context.ts) owns the shared uncommitted-data notice and binding contract. Initial requests remain unchanged.
- [Historical component probe](../../scripts/experiments/step-transition-candidate-probe.ts) preserves the actual complete failed component and requires its original rejection before one new bounded repair request. Formal admission and independent semantic inspection remain separate from gameplay acceptance.
