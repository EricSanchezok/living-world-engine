# Contextual action suggestions

Artifact-Version: 1
Status: Implemented

## Intent

The human-approved five-point interaction plan makes suggestions a current decision-point presentation result. Suggestions help players formulate attempts without turning prose into world state or revealing another subject's knowledge.

## Contract

- Each active Participant has one current suggestion record: source identity, lifecycle status, up to three short items and a Ledger execution reference. Public API v16 exposes only the ready batch as `conversation.suggestions`; Arrival and response objects have no suggestion fields.
- An eligible decision point includes completed entry and a settled turn whose narration has finished publishing. One asynchronous logical creation-profile request generates the whole batch. It neither blocks input nor changes world revision, time, cognition or action records.
- Input contains only the current Agent's authorized perspective, own goals, recent authorized outcomes and published discourse. Items describe distinct attempts, avoid completed requests and guarantee no outcome. Exact normalized duplicates are removed without replacement. Empty or failed output displays nothing.
- Submission, loss of control and unsettled world work invalidate the current batch. Late completion publishes only against the same source and active generation. Refresh reads the saved result. Process recovery marks interrupted batches failed and does not retry them.
- Suggestions appear below the latest World reply. Choosing one fills the composer without submitting. A nonempty draft hides suggestions; generation never claims focus or overrides reading position.
- Instance schema v29 and `.livingworld-v29/` form a forward-only boundary. The old directory remains intact; no migration, compatibility field or static fallback is introduced.

## Plan

Implement a server presentation module for context, source reconciliation and batch generation. WorldHost schedules work and persists its result through the existing instance/Ledger and notification paths. Update the public and saved contracts together, remove Arrival-owned suggestions, and update presentation documentation and the architectural decision.

## Verification

Exercise real WorldHost and persistence with only model transport replaced. Cover successive contexts, creation-profile binding, cognitive isolation, deduplication, stale completion, failure, refresh, restart and control transfer. Browser flows cover draft protection and new batches. Run `check:fast`, `check:ui` and local startup acceptance.

## Evidence

- [WorldHost integration coverage](../../src/server/__tests__/suggestions.test.ts) exercises two successive turns, authorized context, creation-profile evidence, duplicate removal, stale completion, control transfer, failure and restart recovery through real persistence and model transport.
- [Route coverage](../../src/app/api/__tests__/instance-routes.test.ts) verifies the public conversation contract; [browser flows](../../e2e/flows/immersive-game.spec.ts) verify refreshed suggestions and draft protection.
- `check:fast` passes with 2,367 tests; `check:ui` passes with 12 browser flows and four accessibility checks. The participant conversation visual baseline is verified on macOS and Linux.
