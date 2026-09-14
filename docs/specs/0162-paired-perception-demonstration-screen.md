# Paired Perception Demonstration Screen

Artifact-Version: 1
Status: Approved

## Intent

Test whether paired semantic demonstrations improve present-onset decisions under the [complete-player objective](0122-player-action-efficiency.md). This benchmark-only intervention adds authored input/output cases to the perception system prompt. It implements neither retrieval nor an executable action theory.

## Contract

Eight synthetic cases contrast pending delivery with an authored active relay, ordered work with concurrent speech, silent conditional intent with an audible conditional offer, and supported uncertainty with a fixed failed check. The two delivery cases contain mixed observer decisions. Example references belong only to the miniature cases; no bundled-world identity or historical answer is included. Cases are development instructions, never held-out evaluation or canonical evidence.

Keep the complete original source, output schema and generated JSON-shape example, request parameters, check materializers, observer-local identity rules, RNG ownership and repair policy. Only append the version-bound demonstration asset to the system prompt. The adapter cannot change the context, schema, decoder or user message. Physical request comparison checks the complete body, including all inference fields.

## Plan

After relevant checks and check:fast, freeze four first-response calls in B/C/C/B order on the complete forty-nine-subject, forty-nine-action, eighteen-target historical initial-perception source. B is its exact original physical request; C adds only the demonstrations. Use official deepseek-flash with thinking disabled, one concurrent HTTP, zero transport retries, zero repairs and zero follow-up calls. Retain all responses and billing audits; a missing audit stops the trial. Check requests are assessed through the real deterministic proposal materializer without drawing randomness or continuing. Done outputs use the original receipt materializer. No world state is committed.

Review every returned report or requested check against its full source and observer evidence. Passing structural validation alone cannot qualify the candidate. Any semantic counterexample rejects promotion; otherwise independent held-out testing and a fresh full-player run remain required. All historical failures remain in the evidence and no response is replaced by resampling.

## Verification

Validate every demonstration output with the canonical directive schema. Exercise the actual TruthEngine and gateway for no-stimulus and perceived outputs, successful check continuation, a failed check bypass and a foreign observer-local identity. Compare full physical B/C requests and preserve complete input and RNG state. Reject duplicate application and physical changes outside the system suffix. Synthetic transport tests establish wiring and guardrails, not model accuracy.

## Evidence

[Demonstration tests](../../src/engine/benchmarks/step-efficiency/__tests__/perception-demonstrations.test.ts) own engineering evidence. [Decision 0208](../decisions/0208-screen-paired-perception-demonstrations.md) records the alternatives and literature limits.
