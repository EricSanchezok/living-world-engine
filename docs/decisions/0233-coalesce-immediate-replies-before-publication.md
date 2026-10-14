# Coalesce immediate replies before prose publication

## Status
Accepted
Class: architecture

## Context and Problem Statement

A player's spoken question and the immediately queued character response can generate separate prose jobs. The first job has only the player's own words and little else to narrate. Expanding that small receipt encourages filler, repetition and invented listener reactions. The first confirmation records these expression failures.

## Decision Drivers

- Publish a coherent exchange from actual delivered words.
- Preserve durable outbox work and immutable published paragraphs.
- Avoid blocking on background conversations or admitted long activities.
- Reduce prose requests without changing world behavior.

## Considered Options

- Publish every spoken receipt immediately as its own narrative job.
- Wait for all character activity in the world to finish.
- Merge an unstarted own-speech beat with its immediately ready direct replies.

## Decision Outcome

Choose the third option under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md). An unstarted beat containing only the participant's speech waits while the same active run has a model-controlled, immediately ready response caused by that submission. Its next committed observations merge through the existing outbox. An active physical activity, stopped run, failed task or unrelated background conversation does not require waiting. Published or already attempted beats retain their existing continuation lifecycle. Reconnecting clients read saved paragraphs and do not initiate model work.

## Pros and Cons of the Options

- Per-receipt publication displays the first words earlier but spends a prose call restating the player's input and separates the actual reply.
- World-wide completion can give a broad scene but delays the player's answer behind unrelated work.
- Causal merging reduces redundant jobs and gives prose an actual exchange to express. The first paragraph can arrive later when an immediate response is still computing; admitted activities remain eligible for incremental feedback.

## Links

- [First confirmation evidence](../research/2026-10-14-conversation-continuity-confirmation.md)
- [Causal foreground selection](0232-participant-replies-and-background-conversation.md)
- [Narrative lifecycle](../game-design/narrative.md)
