# Short Action Checkpoint World

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), test whether treating generic short-action times as progress boundaries prevents unsupported completion without increasing model strength or restricting action scope.

## Contract

This is an isolated world candidate, not a compiler codec or a runtime migration. Only the explicitly named momentary-action and brief-action profiles in the full finite-work-goal source world change from fixed to goal, retaining their one-second and ten-second intervals, IDs, selection tags, resource claims and interruption settings. Their labels and calibration explanations describe progress checks. Explicit-duration, rate, staged, conditional and ongoing contracts remain intact. No generic fixed-profile conversion or natural-language classifier is added to the kernel.

The existing goal runtime retains an unfinished activity at a checkpoint and completes it only from its supported terminal outcome. A genuinely brief successful action can complete at its original first boundary. A checkpoint does not establish goal achievement. The complete original action, full world, model settings, existing adjudication and verification calls, and bounded recovery remain required. Existing worlds, saves, failed trials and accounting remain intact. Preparation sends no HTTP and cannot authorize runtime promotion.

## Plan

Prepare immutable full-world assets through the shared script loader. Verify that reversing only the declared profile and calibration changes restores the source template, and preserve all other assets. Demonstrate both the historical clock-only completion and the candidate's continuing and terminal behavior through actual temporal materialization and advancement. Use subsequent independently frozen model trials to assess profile selection and actual world effects.

## Verification

Check source drift, unchanged profile count and unrelated world contracts, complete Agent/entity counts, state binding and persisted asset round trips. Exercise a compound task at its first checkpoint, repeated unfinished checkpoints, a genuine brief completion, resource ownership and terminal release, explicit-duration completion and cancellation. A source-bound false success or repeated no-effect continuation vetoes gameplay acceptance. Measure checkpoint count, useful simulated progress, all calls, tokens and latency; avoiding premature completion alone is insufficient. Run relevant checks and check:fast before committing.

## Evidence

[Decision 0135](../decisions/0135-adjudicate-generic-short-action-completion.md) owns the alternatives. The STEP-E2 evidence ledger retains the original game07 actions and their unsupported fixed ten-second schedules; [0044](0044-source-indexed-planning-records.md) remains separately qualified and its failed review is not overridden by this experiment.
