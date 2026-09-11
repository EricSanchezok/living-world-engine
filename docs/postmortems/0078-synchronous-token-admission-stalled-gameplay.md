# Synchronous Token Admission Stalled Gameplay

Artifact-Version: 1

## Executive summary

A gameplay diagnostic stopped before its first commit when a local token-count subprocess timed out. The affected model request was never dispatched. Its complete input counted successfully offline, so this was not a context overflow or evidence of a model semantic failure. Synchronous process execution also blocked the game event loop while another HTTP request was active.

## Summary

The run completed eight model requests with known usage and preserved revision zero. The ninth admission check timed out after thirty seconds. Its exact recorded messages contained 68,606 content tokens, well below the unchanged context limit. No additional unknown billing reservation was introduced.

## Timeline

- The integrated candidate passed the repository gates and a complete offline transition round trip.
- Bootstrap completed; action compilation admitted one request while checking another.
- The second compilation request's local subprocess timed out before budget reservation or HTTP dispatch.
- The existing stop path drained the already dispatched request and wrote a stopped report.
- The exact blocked input counted correctly offline and in twelve consecutive checks with the game retrieval runtime loaded.
- Admission moved to asynchronous subprocess pipes, retaining the same tokenizer, complete inputs, output ceiling and timeout.

## Root cause

The admission implementation used execFileSync inside the live fetch boundary. A delayed child therefore prevented the main event loop from processing unrelated responses and stop/report timers. Offline correctness tests verified token arithmetic and immutable assets, but did not test event-loop responsiveness during an admission task. The specific reason for the one child-process timeout remains unconfirmed; the offline repetitions did not reproduce it. The fix removes the known blocking design and adds subprocess progress to future failure evidence without claiming the intermittent timeout is fully explained.

Yielding introduces a separate correctness requirement: available budget and stop state may change while counting. The runner rechecks both immediately before reserving a dispatch ordinal and entering transport. Admission evidence uses its own unique ordinal and records the actual dispatch ordinal, so concurrent checks cannot overwrite one another. No timeout is retried automatically.

## Guardrails

- [Admission tests](../../scripts/experiments/deepseek-context-admission.test.ts) exercise concurrent large pipe inputs, an event-loop heartbeat, timeout termination and failed child exits.
- [Gameplay runner](../../scripts/operations/step-efficiency-playtest.ts) rechecks stop state and capacity after admission yields and preserves non-dispatch failure evidence.
- [Mechanical preflight](../../scripts/experiments/step-mechanical-transition-preflight.ts) freezes artifacts under their exact code commit, preserving prior failed-run evidence when infrastructure changes.
