# Natural action time and world initiative

Artifact-Version: 1
Status: Implemented

## Intent

Improve the naturalness of ordinary play without adding a director, background real-time simulation or a second execution path. The player-authorized scope includes realistic action time, meaningful feedback, locally motivated initiative, and up to three real-model play-and-tune cycles.

## Contract

- Missing duration requests semantic judgment in the existing world adjudication call. Authored timing rules, calibrated scales and explicit action-bound durations govern every action kind. Concurrent activities retain their own deadlines; reading and typing consume no world time.
- Interpretation pursues the player's authorized intent through necessary low-risk continuity. New spending, commitments, risk choices and voluntary player dialogue require authorization. A genuine decision, missing evidence or reply can suspend a request.
- Existing adjudication may disclose salient perceptible context and propose plausible local developments. These remain subject to world admission, cognitive isolation and committed evidence; narration cannot invent canonical changes.
- A fresh player request admits relevant ready NPC decisions alongside the player. Relevance comes from local contact, delivered events or goal associations, not the complete world roster. NPCs may wait. Background work does not extend the player turn indefinitely; existing direct replies and requested fulfillment retain their causal foreground.
- Timing and perception reuse existing model calls. Independent decisions run concurrently. Additional calls correspond to useful eligible NPC decisions or existing creation needs, never a mandatory extra per-turn pass.
- Replace the current producer directly and use a fresh default data directory, preserving old directories without migration or fallback producers. The public conversation/composer contract remains unchanged, including progress until complete reply publication.

## Plan

Deliver two independently checked units: action timing and natural feedback; bounded local initiative. Maintain the owning execution reference and decision rationale. Freeze a small cross-scenario evaluation corpus, compare actual world transitions and published replies, then perform up to three live play-and-tune cycles using the public participant API.

## Verification

Exercise timing across speech, observation, work, waits and concurrent activity; explicit duration ownership; cognitive isolation and no unauthorized action; scene feedback without mandatory tours; relevant initiative without global activation or endless foreground. Run focused tests, `check:fast`, `check:ui`, world validation and debug integrity checks. Record real model latency, call counts, world time, outcomes and player-facing quality rather than treating model self-report as verification.

## Evidence

The implementation passes `check:fast` (2,415 tests in 362 files), `check:ui` (16 interaction and 4 accessibility tests), bundled-world validation and [Direct entry regressions](../../src/engine/direct/__tests__/runtime.test.ts). Those regressions cover action-bound duration, model-selected ordinary timing without an extra adjudication call, incidental context ownership, bounded local initiative, new-recipient delivery, concrete NPC physical methods and recorded replay. [Activity coverage](../../src/engine/direct/__tests__/activities.test.ts) retains shared-resource queues, earlier timers and ongoing work.

Real-model qualification includes two baseline turns and three tuning cycles of 3, 6 and 11 player turns through the public participant API. The final cycle reaches a destination and obtains an answer within one compound request, preserves conditional payment authority, debits one coin exactly once, records physical follow-through, advances an explicit wait by 120 seconds, and performs presentation clarification with zero elapsed world time. The third-cycle run records 119 model invocations, including one rejected output recovered through repair. These are short trajectory observations, not a controlled latency benchmark or proof of long-horizon narrative quality. Complex turns still take roughly 50–70 seconds and some exchanges require prompting; no guaranteed dramatic pacing or completion score is claimed. [Postmortem 0168](../postmortems/0168-minimum-time-and-muted-world-feedback.md) records the failures exposed by play and their permanent guards.
