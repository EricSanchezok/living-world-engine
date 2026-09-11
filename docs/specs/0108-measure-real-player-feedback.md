# Measure real player action feedback

Artifact-Version: 1
Status: Approved

## Intent

Measure the authorized gameplay objective through the actual participant submission and persisted conversation path. Observer advancement and queued acceptance cannot establish player feedback latency.

## Contract

A frozen player scenario contains an existing world origin, three natural-language actions and the explicit test-player policy to keep the original action when offered a reaction. The complete original NPC and Entity rosters remain present; normal origin admission adds the controlled participant and its script-owned assets. Model settings, world content, execution algorithms, budget accounting and live run leases remain unchanged.

Timing begins before WorldHost.submitAction. Report the first observed persisted feedback and the completed action run separately. Every feedback must identify the same submitted action and a contiguous positive-time committed history entry; its canonical truth must replay. Arrival text and enqueue acknowledgements never count. Polling measurements are upper bounds at the recorded polling resolution. Runs may produce multiple feedback checkpoints. Automated keep reactions remain explicit evidence, not a claim of tested user reaction diversity or browser latency.

Capture each committed checkpoint while the normal action run continues. After the action reaches its next decision point, require source review of every captured checkpoint before submitting another action. Review time lies between actions, outside their measured latency. This allows the real continuous run to finish without substituting test-only scheduling for production behavior. Failed or paused runs retain partial feedback but cannot count as completed actions. Stop further dispatch after an instrumentation failure and drain live engine work before closing persistence. No failed trial restarts or extra budget tranches are created.

## Plan

Extend the existing cost-accounted playtest with a player scenario and a shared measurement helper. Freeze the first full-world player diagnosis only after relevant tests and check:fast pass. Three reviewed actions remain exploratory evidence; a separate fresh trajectory and actual UI feedback verification are required before claiming continuous sub-minute gameplay.

## Verification

Use the real WorldHost, world loader, participant admission, transaction log and public conversation with only the external model boundary controlled. Hold a model response to prove queued acceptance is not measured as feedback. Verify persisted feedback after host reconstruction, positive time and exact submitted identity; an injected terminal provider failure must leave no invented successful latency or revision. Preserve raw requests, responses, per-checkpoint source evidence and costs in the existing isolated experiment directory.

## Evidence

[Player measurement tests](../../scripts/operations/player-feedback-playtest.test.ts) exercise the real player path. [The playtest runner](../../scripts/operations/step-efficiency-playtest.ts) owns budget and source-review integration. [Source review](../../src/engine/benchmarks/step-efficiency/trajectory-source-review.ts) remains independent of successful persistence.
