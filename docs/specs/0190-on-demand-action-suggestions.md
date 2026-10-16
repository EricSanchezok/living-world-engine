# On-demand action suggestions

Artifact-Version: 1
Status: Implemented

## Intent

The human-approved interaction replaces automatic suggestion generation with an explicit action beside the latest reply. Players can request a batch or replace it without advancing the world. Generation must avoid long reasoning and references that the conversation has not introduced.

## Contract

- Entry, completed turns, reads, reconnects and restart perform no suggestion inference. A stable decision point exposes an idle control. One accepted explicit request starts one logical creation call; concurrent or replayed requests cannot start duplicate work.
- First generation and replacement share one endpoint and worker. Source identity fences the decision point; request identity and an expected previous request fence replacements within that point. Submission, control transfer or unsettled world work invalidate the source and cancel obsolete work.
- Replacement retains the current items until a successful batch arrives. Failure and interrupted recovery retain those items and allow explicit retry. Previous items are supplied as avoidance context; normalized repeats are removed without padding.
- The model receives published arrival and conversation text, player actions and the current character's own goals. Unpublished location descriptions, entity catalogs, mechanical labels and internal outcome receipts are excluded. Goals and previous suggestions establish no scene facts: unknown targets require discovery or a question. Suggestions use only names and scene details introduced in the published text and never promise success.
- The bound creation profile and pinned model remain authoritative. A trusted, capability-validated inference override disables reasoning for suggestions; the effective inference is hashed and audited. No extra repair call, alternate producer or static fallback is introduced.
- The latest World reply offers an action beside copy. Pending requests show progress in place and do not block input. Ready suggestions appear together; replacement retains the old batch until completion. Selecting an item fills the composer, and nonempty drafts hide suggestion controls. New turns show the idle action again.
- Public API v17 and instance schema v30 expose and persist the current source, request, lifecycle, items and execution reference. The default data root is `.livingworld-v30/`; older directories remain intact without migration or compatibility paths. Suggestion requests do not change world revision, time, cognition or actions.

## Plan

Replace reconciliation and request ownership in the suggestion module and WorldHost, add the participant endpoint and client control, tighten context and prompts, and validate the inference override through the existing gateway. Update the presentation contract and supersede the automatic-generation decision.

## Verification

Exercise the real host, persistence and HTTP boundary with only model transport substituted. Cover absence of automatic inference, replacement, duplicate/stale requests, late completion, failures, restart, control changes, unpublished-name exclusion and actual wire inference. Verify draft and focus preservation in browser flows, run `check:fast` and `check:ui`, then open a fresh real-model game and record latency and token evidence.

## Evidence

- [Host integration](../../src/server/__tests__/suggestions.test.ts) and [HTTP coverage](../../src/app/api/__tests__/instance-routes.test.ts) exercise idle entry and turns, explicit request ownership, replacement, stale results, interruption and control changes. [Gateway tests](../../src/engine/models/__tests__/model-provider.test.ts) inspect the effective wire settings and immutable catalog; [probe tests](../../src/engine/models/__tests__/model-invocation-probe.test.ts) retain task policy when replaying a request.
- [Browser coverage](../../e2e/flows/immersive-game.spec.ts) verifies generation without blocking the composer, draft/focus retention, replacement failure and reload reuse. `check:ui` passed 13 flow/visual cases and four accessibility cases; `check:fast` passed 2,384 tests plus lint, type, contract and governance gates.
- Live Blackmarsh instance `ad09677c-b31a-4090-a3cf-79abae74f996` remained idle at entry and after a real action advanced it to revision 3. Requests preserved the world state; a repeated request reused the saved batch. The final prompt's replacement execution `091f7a7f-cca9-4e93-ac85-34c4a4aa62a2` and subsequent-scene execution `4eacd422-a18b-4ad3-bccd-86e1cb209bcc` used the pinned `creation-deepseek` profile, `deepseek-flash`, disabled thinking and zero reasoning tokens. Transport times were 2,269 ms and 1,875 ms; local click-equivalent request-to-observed-result times were 3,497 ms and 2,511 ms, including development route compilation and observation overhead. These are two live samples, not a latency guarantee. Neither request included Merry Legs or unpublished location descriptions. The [original incident](../postmortems/0166-suggestions-assumed-unpublished-introductions.md) records the 9,980 ms reasoning-enabled baseline.
