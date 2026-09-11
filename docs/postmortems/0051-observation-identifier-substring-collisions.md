# Observation Identifier Substring Collisions

Artifact-Version: 1

## Executive summary

The public-information guard compared hidden internal identifiers against arbitrary substrings of public prose. Ordinary English words could trigger an information-boundary rejection even though they did not reveal the identifier. The same substring rule could mistakenly mark a hidden identifier as already visible.

## Summary

STEP-E1 trajectory 12 recorded a rejected Denis observation at Ledger 2342 in execution `54eac7f2-e6a4-45bc-a8b9-db7bc0d72e90`. HTTP 143 contained `foothills` and `households`; these matched other agents' local identifiers `thil` and `hold`. The source response hash is `23c55b02ab12f9b0504b4659cb3f85f2e9e2444890cedba954b72fcd45d98d71`. Replaying the guard with the recorded state and unchanged public prose reproduces the rejection. This diagnosis concerns one literal information check, not the correctness of the complete model observation or transition.

## Timeline

Repeated observation rejections prompted inspection of the renderer's owning information-boundary function. Matching the exact public fields against the source state's protected values identified the two unrelated identifiers. A fixture regression reproduced both the false rejection and the inverse error: previously visible `foothills` could incorrectly whitelist a later standalone `thil`.

## Root cause

The guard stored identifier fields and private natural-language text in one string set. Both the observer's visible corpus and the proposed prose used `includes`. That lost the distinction between a complete reference identifier and a coincidental sequence of letters inside a longer word.

## Guardrails

The [information-boundary guard](../../src/engine/cognition/information-boundary.ts) preserves each protected value's field category. Identifier matching requires boundaries against ASCII letters, digits and underscores, in both visible evidence and proposed prose. Punctuation, canonical reference syntax and surrounding CJK prose still permit a complete identifier match. Private descriptions and text values retain literal substring checks; the same value in both categories retains both checks. No state, reference catalog, model prompt, observation content or disclosure permission is rewritten.

The [regression](../../src/engine/cognition/__tests__/information-boundary.test.ts) covers unrelated word substrings, complete hidden identifiers, case normalization, reference syntax, CJK context, false visibility from longer words, and unchanged private-text rejection. The existing [renderer regression](../../src/engine/cognition/__tests__/observation-renderer.test.ts) continues to reject and repair actual protected canonical text. These finite literal checks do not establish complete semantic non-disclosure.
