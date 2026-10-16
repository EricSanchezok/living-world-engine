# Natural waiting reported as a pause

Artifact-Version: 1

## Executive summary

A finished player turn could start an unsolicited timeout run and then display a resumable pause despite no interrupted work. Solo decision windows now remain open without a deadline, and quiescence finishes successfully as ordinary input readiness or Observer completion.

## Summary

After two live actions, the participant saw a pause console instead of a plain input field. The execution had exhausted actionable events inside its autonomous horizon; it was neither compiling nor failing. Resuming repeated the same no-progress condition. The atomic quiescence path also omitted the execution reference from the run and bypassed instance notifications.

## Timeline

- The player finished an observation and moved under a shelter; narration published normally.
- A 60-second ordinary decision deadline expired while the player was reading, queuing an empty-input run.
- Execution `e4a08451-5b16-4168-b625-cc5adb8c6096` emitted Ledger event 1091, `step.waiting`, and finished successfully, while WorldHost labeled the run `paused`.
- Real host regressions reproduced the incorrect pause and the restarted single-player deadline after narration recovery.

## Root cause

Host scheduling used the same timeout policy for solitary reading, multiplayer collection and urgent reactions. Its quiescence handler reused interruption state instead of distinguishing a successful absence of work. Existing tests covered engine no-progress detection and explicit pause separately, but did not assert their public state difference through persistent WorldHost. The streaming recovery test incorrectly required a new solo deadline.

## Guardrails

- [Direct host regressions](../../src/server/__tests__/direct-world-host.test.ts) exercise real quiescence with zero and two external policies, successful Ledger completion without a commit, notification, execution linkage, no work on reads, rejection of resume, and later explicit input. Stream recovery proves a solo window never receives a positive-delay timer.
- [Host lifecycle coverage](../../src/server/__tests__/world-instance-host.test.ts) retains explicit pause/resume fencing and timed reaction fallback.
- [Participant browser flow](../../e2e/flows/immersive-game.spec.ts) checks the ordinary input state has neither a pause label nor a resume button and receives a deadline-free decision window.
- [Runtime contract](../game-design/engine-runtime.md#worldrun-与暂停恢复) owns the state distinction.
