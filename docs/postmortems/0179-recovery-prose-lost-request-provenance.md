# Recovery prose confused independent events with request progress

Artifact-Version: 1

## Executive summary

Failed real-model turns exposed misleading recovery feedback. An independent NPC payment instruction appeared as completed request progress, and a separate unanswered question became a claim that its addressee did not know the answer. Recovery snapshots retain exact request relations derived from committed frames; narration and publication receive the actual local actor, operation and result. Publication preserves material limits such as the difference between issuing an instruction and receiving payment.

## Summary

On 2026-10-17, the twelve-origin acceptance run stopped before qualification. The lead instance contained one independent NPC speech frame requesting a payment, with no submission or causal action binding. Company funds, personal money and the supplier balance remained unchanged. Recovery generation internally recognized that no receipt or payment number was known, but its published text said the payment-instruction portion was complete. The paragraph carrying the explicit uncertainty was rejected as redundant; the remaining paragraph did not clearly retain the distinction. This was misleading attribution, not evidence that money moved.

The editor instance had no preceding delivered question or answer in its recovery source. Generated prose asserted that the intended addressee did not know the deadline. All six publication checks accepted it. Absence of an answer supported only the participant’s lack of a received answer, not the NPC’s private ignorance. Both original outputs and their accepted checks remain preserved in local acceptance evidence; neither run qualified as successful gameplay.

## Timeline

- Ledger integrity checks, invocation lookup and payload inspection established the frozen scene sources, creation output and publication decisions before source changes.
- The lead source grouped same-window observations as earlier request receipts. Its projected completed-step list omitted the actor and contained an independent NPC instruction.
- A persistent WorldHost regression reproduced an independent NPC instruction during an explicitly requested wait, followed by a failed next player step. The original outbox had no request relation for either receipt.
- The outbox gained code-owned provenance classification; creation and publication share the same visible projection. The permanent regression verifies final persisted player-visible qualifications, bounded rejection of unsupported knowledge, unchanged quantities, strict replay and restart without new calls.

## Root cause

Presentation grouping by submission was treated as execution causality. A run can observe independent autonomous work while a participant request is active. Labeling every grouped observation a completed part of that request and dropping its actor made that false equivalence explicit in the narrator’s input. The narrator’s internal reading was not player-visible, and the continuity check did not clearly protect a new material qualification from being discarded as repetition. The evidence rule also failed to state the distinction between no received reply and another actor’s lack of knowledge.

The correction follows the existing approved [conversational continuity contract](../specs/0184-conversational-continuity-and-recovery.md): requested, completed and pending components remain separate and recovery cannot invent diagnoses. It does not expand narrative authority or add a model call. Instance schema 33 requires the new recovery relation; old saves are archived rather than migrated or interpreted through a text-based compatibility rule. The direct execution producer is unchanged.

## Guardrails

- The [durable outbox](../../src/server/narrative/outbox.ts) classifies each observed receipt using its event-to-frame and causal links. Missing, cyclic or mixed links remain unattributed. A visible name, pronoun or similar wording never supplies causality.
- The [scene projection](../../src/server/narrative/scene.ts) preserves actual local actor, operation, status and result for creation and publication. The [instance validator](../../src/server/world-instance-store.ts) rejects recovery receipts without an explicit relation.
- The [persistent recovery regression](../../src/server/__tests__/narrative-recovery.test.ts) exercises real submission, world execution, outbox, model transport boundary, paragraph publication, save and restart. It checks final visible text, unchanged quantities and replay, not only the model’s internal reading. Existing [direct host regressions](../../src/server/__tests__/direct-world-host.test.ts) retain completed waits and delivered questions after later failure.
- The [narrative contract](../game-design/narrative.md#current-publication-task) owns the semantics. All six publication axes remain required. Focused deterministic tests establish evidence transport and rejection handling; they do not establish that a real model always recognizes these semantic distinctions. No new real-model qualification or latency improvement is claimed.
