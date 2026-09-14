# Conditional Perception Report Programs

Artifact-Version: 1
Status: Approved

## Intent

Reduce serial model calls on the [complete-player critical path](0122-player-action-efficiency.md) by declaring conditional onset reports before the engine resolves perception checks. This is a benchmark capability, not a registered runtime replacement.

## Contract

One source-bound response declares an optional initial check batch and a finite acyclic report program covering every assigned observer/action pair. A report node retains the original report fields, replacing committed check handles with local keys naming that batch's explicit check proposals. A branch node selects by the actual success Boolean of one of those checks. A defer node explicitly identifies unresolved check dependencies and requests ordinary model continuation after the batch resolves. Shared nodes are legal only where assignment and dependency ownership remain valid.

The complete original world, action set, assignments, temporal boundary, instructions and reference catalog remain available. Existing role duties still decide whether a sensory route exists, whether uncertainty is warranted and what is perceptible now. A future task effect, an important action or an assigned pair does not establish a perception check. The program cannot select numeric modifiers, rewrite evidence, select a die outcome, average worlds, create a sensory route or replace a required check with certainty.

The runtime's original check materializer validates the entire declared batch before randomness. Local branch execution reads only the actual engine-produced committed result matched to the declared request identity. Reports and branch dependencies stay with their assigned observer and source action. Every possible graph edge is structurally validated; cycles, unknown nodes, uncovered assignments, unused check declarations, wrong check ownership and stale source bindings fail closed. The selected terminal reports pass the original schema and receipt materializer using the actual committed checks. Unexecuted report text is an untrusted conditional hypothesis, not accepted evidence or world state; this screen does not claim exhaustive semantic validation of unexecuted branches.

No-check programs return their original terminal reports immediately. A program with checks uses the same check materializer, RNG resolver and receipt materializer as TruthEngine; local branch execution requires no additional HTTP. If a reached node defers, the whole report decision continues through the ordinary complete-context model protocol; partial compiled reports are not merged into a new model answer. The ordinary engine replays the actual declared initial batch and its one paid audit from the original RNG, deriving the same fixed results; it receives no invented model invocation. Only the returned transcript can proceed toward a world commit. An initial no-check program cannot defer. The benchmark retains the runtime random-round ceiling and permits zero semantic repairs. A failed selected report remains failed and does not trigger an unrecorded replacement program.

The capability records the program binding and executed branch trace. Actual HTTP audits occur once; local continuation carries zero new invocations. All model work, deferred work, repairs, rejection and RNG commitments remain visible. This capability never mutates its source or commits a world step. Model-facing branches do not expose another Agent's hidden cognition to an ordinary client.

## Plan

Implement a benchmark onset capability. Capture the actual initial request through TruthEngine without HTTP, then bind it to the complete source. Validate and retain the model program, materialize checks through the existing kernel functions, and map check keys to exact result identities. Validate shared graph joins with topological dataflow: success guarantees intersect and previously tested checks accumulate across incoming paths. Use explicit ordinary continuation for deferred decisions. Keep canonical onset and commit contracts unchanged.

## Verification

Compare the program and ordinary two-call protocol through the real model gateway and TruthEngine using controlled HTTP. Verify identical requests, outcomes, receipts and final RNG for successful and failed checks, one HTTP versus two, no-check execution, explicit deferral, multiple pairs, shared checks, graph rejection, source drift, wrong check bindings and invalid selected reports. Freeze checked code and complete source before a bounded live screen. Report semantic review and all added output tokens; a one-call program or mechanical receipt is not the sixty-second complete-player result. Run check:fast before the local producer commit.

## Evidence

[Decision 0220](../decisions/0220-compile-conditional-perception-reports.md) owns the alternatives and research provenance. [Program tests](../../src/engine/benchmarks/step-efficiency/__tests__/perception-report-program.test.ts) own executable equivalence and rejection evidence.
