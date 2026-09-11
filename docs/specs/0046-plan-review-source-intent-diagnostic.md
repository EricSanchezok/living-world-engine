# Plan Review Source Intent Diagnostic

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), diagnose whether the reviewer confuses engine-owned original intent with a planner's proposed result or asks for an impossible repair of a field absent from the planning wire.

## Contract

The opt-in logical review wrapper checks that every reviewed goal equals the assigned source action goal, then appends an explicit field-ownership and attempt/result distinction. It leaves every context value, schema, source plan and existing instruction intact. It does not override a verdict, rewrite a goal, accept empty-effect plans mechanically or bypass semantic review. Default runtime prompts and registered Compositions remain unchanged.

A prospective paired development diagnostic uses twelve independent controlled requests, six positive attempts and six unsupported result claims. Both arms receive identical full fixture-world snapshots, original actions, active goal Activities, rules and plans; labels and arm names stay outside model inputs. Three negative cases place the unsupported result in an effect and three place it in the means text with null effects. Labels derive from explicit authored constraints and source state, not model self-evaluation. The real verifier context builder and existing review schema/batching own each request. A positive goal may mention an unverified objective without declaring it achieved.

## Plan

Freeze complete requests, labels, ordering, prompt hashes, model settings and bounded costs before sending. Use only disabled-thinking DeepSeek Flash, fixed B then C order, one twelve-slot physical root per arm with at most two structural repair calls. Both arms run regardless of semantic reject verdicts because the negative controls require rejection. Unknown billing stops all dependent sends. Any repair or classification error prevents qualification. These development cases are not a held-out calibration set and cannot retroactively qualify a failed source trial.

## Verification

Require exact source-goal equality before dispatch, unchanged request context and schema, distinct plan/action bindings, and formal validity of every proposed plan. Verify that automatic no-effect receipts contain no effects and that unresolved goal work remains active at its checkpoint. Positive recognition and negative recognition must each be six of six in the candidate's first response, with correctly assigned finding references. Preserve both arm results regardless of success. A future new-source qualification and complete-world behavior checks remain necessary; no repeated review of the frozen indexed plans is permitted to obtain acceptance. Run focused tests and check:fast before commit.

## Evidence

The original source-goal ownership is implemented by the plan materializer in the [Truth Engine](../../src/engine/mechanics/truth-engine.ts). STEP-E2 retains the rejected Iseult review, the original goal Activity with no scheduled completion, and the complete request hashes. [0045](0045-short-action-checkpoint-world.md) addresses the separate generic short-duration contract.
