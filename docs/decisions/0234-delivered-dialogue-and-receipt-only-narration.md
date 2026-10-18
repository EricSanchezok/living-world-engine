# Render established dialogue directly and narrate new receipts

## Status
Accepted
Class: architecture

## Context and Problem Statement

The confirmation regressions contain correct delivered exchanges whose later prose adds bodily actions, repeats an old movement or changes the apparent speaker. The narrator also received original compound requests through publication metadata even though its evidence projection excluded them. That duplicates intention beside execution and undermines the boundary in [0229](0229-open-creation-and-durable-narration.md).

## Decision Drivers

- Preserve the exact words and identity of each speaker.
- Keep open character creation and natural descriptions of new scenes.
- Give ordinary narration completed receipts rather than unexecuted requests.
- Avoid another creative request where only attribution is needed.

## Considered Options

- Regenerate all visible text with increasingly detailed prose instructions.
- Render every result with fixed observation templates.
- Render already introduced, unaccompanied dialogue directly; narrate other scenes from their new receipts.

## Decision Outcome

Choose the third option under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md). A fresh beat consisting entirely of successful delivered speech can persist attributed literal words without a second model request when every non-player speaker and visible detail is already introduced and no accompanying manner is recorded. Player speech must equal the original input; stage directions and compound inputs remain eligible for narration. New introductions, physical acts, changed details and clarification use the existing narrative lifecycle. Recovery follows the narrow direct processing-status exception in [0267](0267-render-known-processing-failures-directly.md); other recovery explanations retain creation. Deterministic dialogue retains stable paragraph sequence, local mentions, persistence and the same feedback-window release. It records no invented model producer or request.

Ordinary prose receives current receipts and published conversation history. Historic raw requests and old action memories are omitted from this presentation projection; the authoritative audit is unchanged. Clarification and recovery retain their actual question and prior executed progress. A short optional source reading precedes generated prose so the creator identifies actual results, remaining uncertainty and speaker order. It is diagnostic and cannot create an event or block valid output when omitted.

## Pros and Cons of the Options

- Regenerating every exchange offers more varied transitions but introduces another opportunity to invent actions and misattribute words.
- Universal templates avoid creative overreach but cannot provide the requested scene detail and flexible storytelling.
- Conditional literal rendering preserves freely generated NPC words, saves unnecessary requests and makes attribution exact. Quiet exchanges have plainer transitions. New scenes still require grounded generation and remain subject to semantic error.

## Links

- [Confirmation regressions and full transcripts](../research/2026-10-14-conversation-continuity-regressions.md)
- [Narrative lifecycle](../game-design/narrative.md)
- [Immediate reply coalescing](0233-coalesce-immediate-replies-before-publication.md)
