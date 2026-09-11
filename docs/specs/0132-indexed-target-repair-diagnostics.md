# Indexed Target Repair Diagnostics

Artifact-Version: 1
Status: Approved

## Intent

Test whether mapping rejected canonical effect targets to their current generated fields reduces the repeated empty-target failure in the complete-player diagnostic. This is a recovery experiment under [0029](0029-nonthinking-gameplay-efficiency-experiment.md), not evidence of first-pass or complete-player success.

## Contract

An explicit benchmark adapter annotates only indexed planning repairs containing a source-bound rejected plan and an unresolved effect target. It matches the rejected plan's action reference to the current physical action index and original logical slot, preserves the previous candidate and all original issues, and identifies the generated targetIndices and effect targetPosition relationship. The existing complete current target inventory remains authoritative. Previous positional values describe the rejected request and never select a current entity.

The adapter changes no initial request, schema, output decoder, accepted value, canonical validator, context visibility, action cardinality, repair allowance, model or inference setting. Candidate hashes, action membership, diagnostic paths and original rejected values must agree before annotation. An annotation cannot guess a target, rewrite an effect, declare a semantic judgment correct or suppress another issue. Modified source or annotations fail before decoding.

The preserved repair candidate contains reversible selector and factor encodings. Restore those fields through the existing decoders before comparing the canonical candidate hash; never compare encoded bytes to a canonical binding or silently replace the binding. An unrecoverable binding is a configuration failure, not permission to annotate uncertain evidence.

## Plan

Exercise an actual gateway rejection followed by the annotated repair. Freeze both complete historical planning-repair sources from integrated-player-09 and replay their saved responses through the original physical decoder and slot validators with zero HTTP. Then compare original and annotated requests in alternating order, one new response per arm per source, at most four HTTP calls with DeepSeek Flash thinking disabled. No subsequent repair or continuation is dispatched. Bind source, request, code, profile and output hashes; retain every failure.

## Verification

Require identical initial HTTP bytes and unchanged decoding of every saved response. Verify action reindexing, cross-slot refusal, unchanged valid neighbors, multiple effect failures, retained unrelated diagnostics and source-mutation rejection. Measure full request overhead, first-response rejection and accepted logical slots separately from semantic materialization and source review. Both historical sources come from one failed trajectory and are not independent reliability samples. A recovery improvement cannot qualify a full-player run or satisfy the under-60-second objective. Run focused tests and check:fast before committing and dispatch.

## Evidence

[Decision 0185](../decisions/0185-map-indexed-repair-fields.md) owns alternatives. The [adapter](../../src/engine/benchmarks/step-efficiency/indexed-target-repair.ts) owns the input-only mapping; [source-indexed planning](../../src/engine/mechanics/source-indexed-planning.ts) retains authoritative decoding.
