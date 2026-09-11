# Transition Schema References and Context Admission

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), preserve the complete [0052](0052-transition-participant-evidence.md) source while avoiding its observed provider context overflow. The rejected request had 926939 input tokens plus a 131072 output limit, exceeding the 1048576 context window. Its unknown usage reservation and closed trial remain intact.

## Contract

Factor exactly identical causal-assertion schemas into one local draft-07 definitions entry and replace their schema positions with sole-key local references. Traverse schema keywords only, never literal data in const, enum, examples or defaults. Expanding those references must restore the exact original schema hash. No output fields, variants, required constraints, state, actions, references, generation settings or semantic meaning change. The existing canonical validator remains authoritative; model compliance with a compact schema remains an empirical question. Keep all participant evidence and the explicit required first assertion.

Before any model dispatch, tokenize the complete actual system and user messages with the pinned public DeepSeek V4 Flash 0731 tokenizer. Verify the asset hash and tokenizer runtime version. Preserve the 131072 output limit and require local message tokens plus output limit plus a 1024-token protocol allowance to fit 1048576. Three recorded source requests have provider counts exactly24 tokens above the public tokenizer's content counts; this calibration supports the allowance but is not proof that every provider version uses the same wrapper. Unsupported message shapes, model settings, missing assets, altered assets or over-limit requests fail locally before reservation and HTTP. Check repairs independently; never truncate a repair or silently lower its output budget.

## Plan

Verify schema inverse identity and the actual complete request offline, then freeze a new full twelve-slot/forty-three-action diagnostic using the shared launcher. Preserve disabled-thinking Flash and all prior participant/source semantics, at most one structural repair and two HTTP, no transport retry or redraw. Keep the existing STEP-E2 total and phase limits, including quarantined unknown reservations. Formal admission only permits independent source-semantic review; prior semantic failures and context-overflow trials remain closed. A gameplay trial still requires separate frozen code and source review.

## Verification

Exercise exact schema expansion, immutable source, malformed or conflicting definitions, unmodified const/enum literals, valid and invalid canonical outputs, and full gateway recovery. Test context admission at and beyond the allowance-adjusted bound, invalid token counts, missing/altered tokenizer assets and unsupported request shapes. Replay the recorded over-limit body locally and verify rejection without a provider call. Run focused tests and check:fast before each independent commit and paid freeze.

## Evidence

The local STEP-E2 directory retains the original400 response, its full reservation quarantine, three tokenizer calibration requests and prospective actual-body fingerprints. [JSON Schema reference semantics](https://json-schema.org/understanding-json-schema/structuring) define local reference behavior, including draft-07's ignored sibling keywords. [The official0731 model release](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731/commit/9e165c30e2704aec5d9d593cce3eebd58bbef1cb) supplies the pinned tokenizer asset. Byte savings and token estimates do not establish semantic improvement, billing settlement or gameplay acceptance.
