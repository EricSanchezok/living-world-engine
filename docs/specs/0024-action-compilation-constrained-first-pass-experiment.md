# Action Compilation Constrained First-Pass Experiment

Artifact-Version: 1
Status: Approved

Experiment-Protocol-Version: 2

Approved by the user on 2026-09-06: “批准啊，赶紧执行，我要出去一趟，回来之后你必须把实验方案全部跑完”. This approval applies to this contract and its existing readiness and monetary limits, not to bypassing gates or increasing the scope.

The user additionally authorized autonomous adjustment on 2026-09-06: “你自己调整，别再停下来了”, in direct response to the proposed independent model review. Revision 2 prospectively replaces the deterministic-only semantic readiness requirement with the layered evaluation below. No AC-FP2 paid treatment outputs precede this amendment. Monetary ceilings, gameplay freedom, canonical validation and production isolation remain unchanged.

## Intent

Implement and execute AC-FP2 to test whether input-dependent legality constraints and explicit fact snapshots improve first-pass contract-qualified semantic success while reducing total tokens and model invocations. Preserve open action semantics, the original physical batches, candidate retrieval, canonical validation, recovery policy, and world mechanics. The execution protocol owns the detailed schedule, analysis procedure, and operational work packages.

The experiment is separate from [AC-FP1](0023-action-compilation-first-pass-experiment.md). Its frozen artifacts remain read-only. Production defaults, saved instances, model profiles used by production, and the published reference dataset do not change. Running an experiment does not authorize production deployment, push, merge, account purchase, or an increased budget.

## Contract

### Inputs and comparison arms

Use the four official AC-FP1 source captures, their exact state, and all 43 original action proposals. Preserve batch cardinalities 12, 12, 12, and 7. Validate source, state, action, model, prompt, candidate-key, retrieval, and repair-policy provenance before any new provider request. Keep the current FullCatalog v1 dataset as a retrieval regression, not an independent semantic oracle.

The six discovery arms are B (B1-corrected Chat JSON baseline), R (Responses JSON bridge), S (Responses static native JSON Schema), SC (S with input-dependent capability schema), SF (S with explicit fact snapshot codec), and SCF (both mechanisms). R isolates the transport change and is not eligible for selection. All arms use the same effective model and inference settings, including disabled thinking and the original 131072 output limit, timeout, and bounded recovery. Unsupported parameter equivalence fails readiness instead of silently changing the baseline.

Capability schema C permits exactly the existing slot-visible keys that the canonical resolver allows for each reference use. It encodes existing required fields and profile-dependent continuation requirements. A fixed-slot object representation decodes bijectively to the original canonical batch. It does not delete semantically plausible choices using heuristics, expand the shortlist, expose another slot's knowledge, or bypass canonical validation. Repair schemas derive from each actual repair request's projection.

Snapshot codec F retains every original literal-value branch. Only an explicit model snapshot selection copies the exact typed value of a valid fact from the pinned compilation state. The value must already be present in that slot's original model-visible projection. The decoder never corrects an erroneous literal, substitutes a different fact, infers relevance, or re-snapshots future state. Entity-valued facts use the canonical materializer. Every decoded result passes through the existing canonical validator.

The new representations and provider adapter use the normal ModelGateway and compiler seams. Experimental manifests pin every behavior parameter, schema, codec, capability snapshot, prompt, model, retrieval subtree, and repair policy. Shared infrastructure is reused rather than maintaining another compiler or recovery implementation.

### Semantic evaluation and freedom

Before paid discovery, bind the 43 existing action-specific must/may/forbidden cards to their exact inputs. Use three separate measurement layers: canonical formal acceptance; deterministic source/identity/typed-state and mechanism invariants; and independent, blinded model review of open-language intent and dependency relevance. The reviewer never sees arm names, cost, treatment prompts or repair order, never enters gameplay prompts, and cannot trigger runtime repair. Its assessments are model-assisted evidence, not human gold or proof of universal semantic accuracy.

Each output receives pass, fail, or unresolved bound to exact action, state, card, review policy and canonical output hashes. Deterministic violations dominate review opinions. Two independently requested, order-reversed reviews must agree for a model-assisted pass; disagreements, absent supporting evidence and unobserved downstream outcomes remain unresolved. Report inter-review agreement and calibration sensitivity/specificity, never fabricate human review. Calibration includes original/acceptable-alternative descriptions and explicit single-factor mutations (invented completion, actor/quantity/privacy/profile changes). Freeze its labels and both reviewer prompts before treatment outputs. A failed calibration prevents a semantic-benefit claim, but not the fixed engineering comparison. The historical 601-output audit remains immutable development evidence, not semantic gold; the 95-percent deterministic adjudicability and exhaustive prose-predicate prerequisites are withdrawn.

Freeze cards, calibration, reviewer configuration and deterministic checks before discovery. New ambiguities remain unresolved; changing rules requires another experiment version. The primary engineering endpoint is original-batch first-pass formal acceptance, with raw structure and deterministic normalizations reported separately. Model-assisted semantic batch success additionally requires every slot to pass deterministic checks and concordant reviews. Report both endpoints, their final-recovery counterparts, slot/source breakdowns and unresolved intervals separately. Semantic comparisons use candidate lower bounds against baseline upper bounds. Passing engineering thresholds alone does not certify semantic benefit or authorize production deployment. Fixed-case results do not establish long-horizon world realism.

### Execution and selection

Discovery runs four sources by six repetitions by six arms, totaling 144 roots. Balanced deterministic arm rotation is frozen before requests. After complete discovery, only S, SC, SF, and SCF may qualify for engineering confirmation. A candidate requires at least three additional first-pass formal successes, no final-formal or historical-success-stratum regression, and no increase in compilation tokens or HTTP calls. Rank by first-pass formal successes, final-formal successes, tokens, HTTP and simplicity (S, SC, SF, SCF). No qualifying arm means no confirmation requests. Semantic evidence is a separately reported safety/claim gate, not silently relabeled formal acceptance.

Confirmation runs four sources by sixteen new repetitions for B and the sealed winner, totaling 128 roots. No discovery output is reused. Engineering confirmation requires at least 61 of 64 first-pass formal successes, at least halving baseline first-pass failures, positive one-sided exact McNemar evidence at alpha 0.05, no final-formal or historical-success-stratum regression, at least 20 percent compilation-token reduction, no compilation HTTP increase, at least halving semantic repair re-invocations, no compilation estimated-cost increase, no mean-latency increase, and P95 latency ratio at most 1.10. Zero baseline failures cannot establish improvement. Report review cost separately and include it in the overall spend ledger. A semantic-preservation claim additionally requires calibrated reviews, no deterministic safety regression, and conservative model-assisted semantic success/failure and unresolved bounds no worse than baseline. All integrity and covered mechanism gates must pass. Freeze confidence intervals, paired resampling and tie-breaking before outputs.

Readiness includes actual native-schema capability probes, at most 24 logical probes with separately counted bounded transport retries. Unsupported schema capabilities terminate this version rather than switching models, falling back to prompt-only constraints, truncating enums, or shrinking batches. Capability probes occur only after live authorization; discovery occurs only after successful probes and a frozen run manifest.

### Cost, persistence, and authority

The independent root is `.livingworld-benchmarks/experiments/ac-fp2/v1`. Additional conservative spending is capped at CNY 950 and also constrained by the unspent part of the user's cumulative CNY 1000 budget. Existing AC-FP1 spending is deducted. Freeze provider prices and a conservative currency-conversion policy before paid calls. Reserve every HTTP attempt atomically, including all repair, split, and transport attempts; settle actual usage and retain reservations for unknown usage. No separate stage token cap replaces the monetary cap.

Before discovery, simulate the complete schedule from historical source-stratified recovery trees, report tail and stress estimates and the theoretical recovery bound, and satisfy the protocol's remaining-budget safety margins. Repeat confirmation feasibility after discovery without changing its sample size. Unknown charges and insufficient budget stop new requests rather than resetting the ledger or increasing authorization.

Persist request intent and reservations before external effects. Preserve request/response evidence, root/parent/split lineage, exact hashes, timing, and usage. Never persist credentials. Unknown network outcomes are not treated as exactly-once calls without provider support. Resume only after verifying the same frozen manifests and ledger; never replace completed trials or cherry-pick reruns. Game databases and old experiment artifacts are read-only.

The v2 CLI exposes prepare, validate, dry-run-all, run-all, resume, score, report, and publish as specified in the execution protocol. Missing approved specification, truthful authorization, readiness evidence, provenance, or sufficient budget prevents paid execution. Offline commands must not make model calls. Every terminal state produces an evidence-backed report, including no candidate, incomplete confirmation, provider incompatibility, budget stop, and integrity failure. Notion publication can retry independently without rerunning model requests.

## Plan

1. Obtain human approval for this specification and retain the linked user authorization.
2. Verify read-only inputs and baseline behavior; implement and validate independent semantic cards, fixtures, and coverage before treatment outcomes.
3. Implement lossless C/F adapters, the Responses gateway seam, atomic monetary budgeting, and versioned orchestration using existing shared infrastructure.
4. Exercise complete offline success, no-winner, interruption, and recovery paths; finish the protocol's consolidated pre-live acceptance package.
5. Execute capability probes, freeze, discovery, mechanically gated confirmation, independent scoring, and the complete Notion issue/result record.

## Verification

Test exact resolver-set equivalence, canonical encode/decode round trips, typed snapshot copying and lifetime, conditional-profile completeness, slot privacy, original batch cardinality, actual serialized request sizing, and unchanged canonical rejection semantics. Exercise the twelve-family mechanism matrix through real engine entry paths with only expensive model boundaries replaced.

Test tri-valued scoring, fixed denominators, source stratification, winner rejection, exact confirmation gates, paired statistics, atomic reservations, unknown usage, interrupted requests, immutable artifacts, deterministic resume, and report-only publication retries. Every independent work unit runs focused tests and `npm run check:fast` before its local commit. Final verification includes prompt and algorithm catalog validation, reference benchmark verification, retrieval parity, Blackmarsh validation, and `npm run build`.

## Evidence

Partial preparation evidence is provided by the [fixed protocol and schedules](../../src/engine/benchmarks/action-compilation/constrained-first-pass-protocol.ts), the [hash-bound historical source/review loader](../../src/engine/benchmarks/action-compilation/constrained-first-pass-sources.ts), and the [offline semantic observability audit](../../scripts/experiments/audit-action-compilation-semantics.ts). The [real-compiler counterexample test](../../src/engine/benchmarks/action-compilation/semantic-observability-audit.test.ts) demonstrates that intact original actions and equal typed plans/dependencies do not establish the meaning of a derived description. The audit explicitly retains unresolved obligations; it is not the completed semantic evaluator required by this contract. Approval and these preparation checks do not establish readiness, paid execution, or experimental success.
