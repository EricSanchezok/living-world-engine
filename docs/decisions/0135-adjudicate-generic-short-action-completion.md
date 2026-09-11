# Adjudicate generic short-action completion

## Status
Accepted
Class: feature

## Context and Problem Statement

A generic fixed short-action profile gives a semantic classifier authority to schedule completion of an arbitrary whole task. Correct descriptions and source references do not prevent a compound task from receiving that profile. The temporal kernel correctly executes the selected contract even when its semantic selection is wrong.

## Decision Drivers

- Preserve full natural-language work and genuinely brief acts with disabled thinking.
- Separate a scheduling checkpoint from evidence of an achieved objective.
- Keep authored quantitative timing and measure the cost of unfinished work.

## Considered Options

- Strengthen the temporal profile selection prompt.
- Require stronger reasoning or extra online classification.
- Treat two generic short profiles as goal checkpoints in an isolated world.
- Convert every fixed or staged profile to goal completion in the kernel.

## Decision Outcome

The isolated experiment world uses existing goal profiles for its two generic short-action intervals. It retains explicit-duration, rate and staged execution and all action content. The existing adjudicator can complete a brief act at its first checkpoint or continue an unfinished task; the clock does not establish a semantic result. Preparation is a checked, immutable source-world transformation with no runtime promotion. Semantic and cost qualification remain mandatory.

## Pros and Cons of the Options

- Prompt clarification preserves the source world but leaves a single mistaken choice sufficient for premature completion.
- Stronger or additional inference conflicts with the nonthinking cost objective and cannot guarantee correct classification.
- Checkpoint profiles reuse existing mechanics and preserve short scheduling intervals. They change the experimental world contract and can increase repeated evaluations; successful observations alone cannot establish efficiency or prevent a semantic adjudicator from falsely declaring success.
- Universal kernel conversion changes trusted authored contracts and silently overrides script semantics.

## Links

- [Experiment contract](../specs/0045-short-action-checkpoint-world.md)
- [Goal activities](0116-goal-directed-temporal-activities.md)
- [PDDL2.1](https://arxiv.org/abs/1106.4561) distinguishes temporal boundaries and conditions/effects; it informs that distinction, not a claim that this open-language engine implements PDDL validation.
