# Unqualified Full Player Diagnostic

Artifact-Version: 1
Status: Approved

## Intent

Use one isolated complete-player run to locate remaining critical-path and semantic failures under the user's autonomous [player-action objective](0122-player-action-efficiency.md). The [report-domain candidate](0130-perception-report-field-domains.md) retains known source failures. Diagnostic execution is permitted without treating those failures as qualified or deploying the candidate to the user's running game.

## Contract

The diagnostic is a separately pinned, unqualified execution composition. It combines the complete perception law index, report field domains and [terminal-closer interpretation](0129-terminal-root-closer-recovery.md) with the existing integrated planning, observation and cognition adapters. Only perception selects this new combination; cognition retains its independently pinned parser and producer. Canonical semantics, complete input, reference ownership, commitments, randomness, repair limits and atomic persistence remain authoritative.

Use a new data root and all 48 original autonomous Agents plus one actual external Participant. Preserve the existing source-bound checkpoint-world variant and its full action completion rule. Use DeepSeek Flash with thinking disabled, the frozen catalog snapshot, one complete original player action and no imported model output or historical preparation. Record source code and composition hashes before dispatch. Limit this run to 120 new HTTP requests, ten minutes of dispatch and six commits per lease, as in the existing player diagnostic. Await already-running work on stop and retain every failure and response.

The protocol explicitly records prior failed source qualification, known counterexample classes and ineligibility for promotion. This authorization permits failure localization; it does not relax any prior experiment's source gate or convert its results into success. Report initialization separately from submission-to-completed-Activity, persisted state and feedback. A partial checkpoint, awaiting-decision state, stopped run or a single fast action is insufficient for the whole objective. Independently review actual player information and all causal changes before another action or any qualification claim.

## Plan

Advance only the diagnostic root version and freeze a new preparation. Verify the registered root sends the new perception policy through the actual gateway, retains canonical rejection, and persists its identity through WorldHost and restart. Run the isolated player action, inspect the Ledger by public invocation identity and compare stage work, repairs and critical-path timing against the historical failed action. Since other engine corrections are included, historical comparison is descriptive rather than an isolated causal estimate.

## Verification

Run focused gateway, composition, player-completion and persistence regressions, then check:fast before committing. Validate the frozen world, all 49 Agents and the external Participant before submission. Match physical requests, responses, audits, source hashes and profile settings; inspect pending work and terminal state. Keep the source counterexamples, exact errors, committed Activity status, player feedback and latency together. The original under-60-second, near-zero-repair and correct sustained-play requirements remain unchanged.

## Evidence

[Decision 0184](../decisions/0184-separate-diagnostic-execution-from-promotion.md) owns this distinction. The [integrated player runner](../../scripts/experiments/player-integrated-playtest.ts) owns limits and evidence capture; [player completion measurement](../../scripts/operations/player-feedback-playtest.ts) owns the completion predicate. No production default is selected by this contract.
