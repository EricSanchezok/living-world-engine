# Shared Grounding Probe

Artifact-Version: 1
Status: Approved

## Intent

Measure whether independent interaction-grounding requests can share repeated world input through the existing reversible slot coordinator under the [non-thinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md).

## Contract

This benchmark-only provider coalesces compatible grounding tasks in fixed batches of at most twelve, using the existing shared-json-v3 context codec and physical-cardinality-slot-repair-v2 delivery contract. Every original action, world value, actor perspective, reference domain, input ordering and repair context must reconstruct exactly from its bound slot. Joint delivery does not merge dependency decisions or allow another slot's references. Each result enters the unchanged grounding materializer and bounded semantic repair loop.

Profile, state/revision, schema, prompt, registry, runtime identity, cancellation and repair boundaries remain part of coordinator grouping. Physical requests use the original model configuration. Shared structural recovery retains exact coverage and previous-output evidence; valid logical neighbors do not acquire another slot's semantic failure. The existing runtime batch metric accepts action-grounding as an explicit phase rather than reporting it as observation.

The reference grounding Composition and game defaults do not select this probe. No cached footprint, prior model judgment or unverified partial world state replaces a new judgment. Offline byte reduction is feasibility evidence only; paid comparisons must freeze source tasks, order, budget, generation settings and semantic criteria before dispatch. Whole-world admission remains separate.

## Plan

Extend the existing coordinator's factored schema dispatch, expose a benchmark-only factory, verify actual gateway delivery and repair ownership, and run check:fast before a local commit. Use captured due-action inputs for a prospective comparison before any registered gameplay promotion.

## Verification

Compare the batch's expanded slot contexts with complete single-request inputs. Require one physical request for two valid tasks and a singleton repair for one rejected result without retransmitting its accepted neighbor. Verify canonical dependency equality, unchanged source state, fixed schema cardinality and exact previous-output diagnostics at the next HTTP request.

## Evidence

The [probe regression](../../src/engine/benchmarks/step-efficiency/shared-grounding-probe.test.ts) owns the gateway boundary. The [shared-context codec](../../src/engine/mechanics/shared-batch-context.ts) owns hash-bound reconstruction and corruption rejection; the [coordinator regression](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) owns grouping, structural recovery, cancellation and batch delivery.
