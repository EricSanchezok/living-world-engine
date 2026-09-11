# CPU Profiler Interrupted the Native Encoder

Artifact-Version: 1

## Executive summary

A full-world diagnostic terminated with SIGILL after six paid initialization requests and before its first action-compilation request. The newly enabled V8 CPU profiler crashed while the native ONNX encoder was executing. No world step committed.

## Summary

The process used Node 23.11.0 on macOS ARM64, Transformers 4.2.0 and ONNX Runtime 1.24.3. The experiment's periodic report remained `running`: a native illegal instruction bypassed JavaScript cleanup. The durable Ledger and six settled request records survived. External closure preserved the original report, recorded the crash, checked the dead writer and retained all historical unknown billing reservations.

## Timeline

- CPU profiling at a 5,000-microsecond interval was added to investigate earlier event-loop delays.
- Initialization completed; the next step entered local candidate retrieval and the process exited with code 132.
- The macOS crash report located the fault in V8's profiler signal handler, interrupting a KleidiAI SME2 matrix kernel.
- An offline reproduction loaded the same E5-base asset and encoded eight batches of forty-eight queries successfully without profiling.
- The same workload with profiling crashed during its first batch. No model HTTP was used in this reproduction.
- The playtest entry points gained a preflight guard; subsequent diagnostics use external sampling.

## Root cause

The reproduced failure requires the profiling configuration in the observed local workload. The precise upstream instruction/streaming-mode incompatibility remains unresolved; this record does not claim a general ONNX failure. Merely checking that Node accepts profiling flags did not exercise the native encoder. JavaScript `finally` and timeout handlers cannot close a process killed by a native fault, so the last progress report was not a terminal result.

## Guardrails

- [Playtest startup](../../scripts/operations/step-efficiency-playtest.ts) rejects `--cpu-prof` on macOS ARM64 before local setup or paid dispatch; [its tests](../../scripts/operations/step-efficiency-playtest.test.ts) exercise the actual entry and allow ordinary non-profiled execution.
- [Indexed launcher](../../scripts/operations/step-indexed-checkpoint-playtest.ts) checks before its offline preparation as well.
- Native crashes require external process-status and Ledger reconciliation. Preserve the last report and unknown reservations; never restart a closed trial ID or treat a stale `running` report as evidence of a live process.
- External sampling changes no model, inference setting, candidate set, or action semantics. Removing the profiler is not an algorithmic success claim.
