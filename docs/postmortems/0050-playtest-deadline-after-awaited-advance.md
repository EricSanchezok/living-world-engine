# Playtest Deadline After Awaited Advance

Artifact-Version: 1

## Executive summary

STEP-E1 trajectory 12 exceeded its prescribed twenty-minute soft step limit. The runner checked elapsed time only after awaiting `WorldHost.advance`, which itself awaits the complete execution. The independent monetary reservation gate eventually rejected new work; the operator also requested a graceful stop. No canonical step committed. This is a runner stopping defect, separate from the model's observation and transition failures.

## Summary

Execution `54eac7f2-e6a4-45bc-a8b9-db7bc0d72e90` began its run at 2026-09-07T03:42:50Z and closed at 04:04:45Z. The frozen report records 211 HTTP requests including bootstrap, estimated peak cost CNY154.166626112, unchanged revision zero, no active requests, and no newly unknown billing. Its transport stop reason is `phase monetary reserve does not fit`; the operator stop flag does not replace that earlier budget evidence. These figures describe the complete trial, not the marginal cost of the timeout defect.

## Timeline

The elapsed-time discrepancy prompted inspection of the public host entry point while the run was active. The monetary gate recorded its first rejection at Ledger 3270, 04:04:22Z. All dispatched requests subsequently returned and the frozen trial closed. A held-open asynchronous operation reproduced the misplaced deadline without another paid run.

## Root cause

The host's public advance method performs the asynchronous run before returning. Placing a polling deadline after that awaited method made the limit ineffective while model requests were still being dispatched. The runner's account transport already rejects future requests once the stop flag is set; that protection lacked a timer covering the awaited advance.

## Guardrails

The [playtest runner](../../scripts/operations/step-efficiency-playtest.ts) arms a soft deadline around the host call. Its callback sets the existing stop flag without cancelling in-flight HTTP. The timer is cleared on either completion or rejection. The existing poll also covers hosts that return before the run finishes.

The [regression](../../scripts/operations/step-efficiency-playtest.test.ts) holds an active asynchronous request open beyond the deadline, checks that the stop flag fires before the operation returns, then releases the request and verifies that subsequent dispatch is rejected. Completion and rejection both clear the timer. The fix does not retroactively validate trajectory 12 or change its frozen evidence.
