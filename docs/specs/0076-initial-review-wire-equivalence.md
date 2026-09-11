# Initial Review Wire Equivalence

Artifact-Version: 1
Status: Approved

## Intent

Preserve the limited first-response plan-review diagnostic when a local batching version changes but every model-visible input is proven identical. The autonomous experiment authorization permits preparation and correction of stale admission metadata; it does not waive semantic validation or the paid-run budget.

## Contract

The existing exact-manifest gate remains the default. One named transition from the no-example physical batch version to the slot-repair batch version may use an explicit equivalence proof. Historical and current physical request evidence must differ only in that exact prompt-version suffix, and each must hash to its respective manifest binding. All logical request hashes, source labels, model settings, registry/catalog identities and other frozen manifest fields remain identical.

The current first request is rendered by the real gateway using the frozen registry and an offline fetch boundary. Its serialized HTTP body must equal the recorded historical body reserialized as JSON. The historical body's hash and first-request identity must validate. No real credential or network dispatch is used. Failed capture, any model-visible change, another version transition or missing proof rejects admission.

The original diagnostic must still have exactly one actual response, all six positive and six negative labels correct, and valid finding targets. The proof applies only to that initial-response result. It does not qualify repair grouping, final-step causal review, new scenarios, continuous gameplay or cost savings. Historical records and costs remain immutable; the new candidate records both physical request hashes and the common body hash as derived evidence.

## Plan

Retain the captured physical request during offline diagnostic preparation. Add the restricted equivalence check to the integrated launcher, render through the gateway's offline boundary, and attach the derived first-response proof to candidate metadata without rewriting historical evidence. Keep every unrelated admission condition intact.

## Verification

Test the valid metadata-only transition and rejection of changed bodies, inference controls, contexts, logical hashes, source labels, historical identity, corrupt hashes, other versions, repair responses and inaccurate labels. Run the historical offline capture through the real gateway, retain its proof, and run relevant tests plus check:fast before committing. Full paid trajectories remain subject to the existing budget and source-review gates.

## Evidence

[Launcher tests](../../scripts/operations/step-indexed-checkpoint-playtest.test.ts) own the proof and admission boundary. [Decision 0141](../decisions/0141-initial-review-wire-equivalence.md) records the choice. The changed batch behavior remains governed by [spec 0070](0070-slot-local-repair-batching.md).
