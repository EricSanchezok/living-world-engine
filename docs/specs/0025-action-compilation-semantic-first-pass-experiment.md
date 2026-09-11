# Action Compilation Semantic First-Pass Experiment

Artifact-Version: 1
Status: Approved

Experiment-Protocol-Version: 1

Approved by the user on 2026-09-06 through “PLEASE IMPLEMENT THIS PLAN” followed by the complete AC-FP3 protocol. The same user subsequently specified that campus Qwen and GLM Coding Plan are free but unavailable and that only DeepSeek can be used. This prospectively binds the two reviewers to DeepSeek Flash and Pro, before any calibration or treatment request. Independent requests from this family do not constitute independent model-family evidence.

## Intent

Test whether complete open-language action batches succeed on their first actual model HTTP request while preserving semantics and reducing repair calls, total tokens, and HTTP requests. The approved Notion protocol owns the operational schedule, detailed thresholds, literature mapping, and stopping rules. The execution record owns mutable progress and issue evidence.

Use the current experiment branch and a separate `.livingworld-benchmarks/experiments/ac-fp3/v1` evidence root. Historical experiments, live game saves, production defaults, and public game APIs remain unchanged. The compiler stays on `deepseek-v4-flash`, thinking disabled, with existing generation settings. No account purchase, push, merge, deployment, or automated restart is authorized by an experimental result.

## Contract

### Shared foundation and representations

Every arm preserves action proposals, context information, original batch cardinality, root shortlist budget, bounded repair, cognitive isolation, and canonical validation. Retain raw responses and apply identical lossless JSON wrapper recovery across transports, recording raw syntax, wrapper recovery, wire schema, materialization, and formal acceptance separately. Recovery cannot add fields, select references, or rewrite semantics.

The encoder's actual model graph, precision, tokenizer truncation, and fingerprint agree. New assets and caches are isolated from historical artifacts. Cold, partially populated, and warm query caches, and changes to other inputs in the same physical encoder batch, preserve each target's candidate selection. During one compiler transaction, freeze the allowed candidates per original action and derive repair subsets without re-ranking against errors or reduced batch cardinality. State drift invalidates the transaction.

The fixed discovery arms are B (corrected Chat JSON), R (equivalent Responses JSON), R+L (lossless evidence layout), R+T (bijective nonempty conditional representation), R+F (explicit visible typed fact snapshot), and R+TF (the predeclared combination). Native static-schema arm R+S is admitted only after actual required-feature and complete-schema probes pass. A successful HTTP response cannot substitute for parser and schema compliance. Preserve literal snapshot alternatives and bind explicit copies to the original state; never repair a wrong literal implicitly. Reuse the compiler, codecs, gateway, and canonical validators.

### Calibration before treatment

Freeze separate stateless Flash and Pro reviewer bindings, prompts, source/state/rules/output evidence IDs, and the holdout labels before requests. The original 188 calibration cases are development data only. The new holdout contains seven dimensions with sixteen positives and sixteen negatives each, plus twenty-eight insufficient-evidence cases. Labels describe controlled transformations and executable facts, not universal judgments about historical free-text outputs. Each packet has one state and rule version and carries no arm, cost, repair-order, expected-label, or mutation metadata.

Each reviewer must achieve at least 95 percent overall positive and negative recognition, at least fifteen of sixteen in every dimension and polarity, and at least twenty-seven of twenty-eight insufficient-evidence judgments. Format, coverage, identity, and evidence-reference errors count as incorrect. An unchanged frozen evaluator gets one holdout evaluation; outcomes cannot trigger threshold changes or holdout-driven prompt tuning. Unavailable models, unreliable account-specific pricing, or failed calibration stop the main experiment and produce a diagnosis.

Mechanical violations dominate model opinions. A certified pass requires both reviews to pass; disagreement is unresolved. Exact evidence references establish provenance, not logical entailment. Report the same-family limitation and unresolved bounds. The reviewer never enters gameplay or triggers runtime repair.

### Schedule, scoring, and claims

Discovery uses the four original sources with 12/12/12/7 actions, six repetitions, and six or seven frozen arms: 144 or 168 roots. Randomize within source blocks with seed 20260906. A candidate needs more semantically certified first-pass batches than B, at least ten percent fewer tokens, no additional HTTP requests, and no observed final-success or semantic regression. Rank by first-pass success, tokens, HTTP requests, then the fixed candidate order in the protocol. No candidate means no confirmation.

Before discovery, seal eight new twelve-action scenarios constructed through real world loading and state validation. Confirmation uses only B and the sealed winner, eight repeats per scenario: sixty-four pairs and 128 roots. No tuning, replacement winner, or outcome-driven sample expansion is allowed. Short trajectories test predefined state/condition/resource/object changes through real execution boundaries, without requiring stochastic complete-state equality.

The primary endpoint requires every original slot to pass formal and semantic checks on the first actual HTTP request; any failed or unresolved slot prevents a batch pass. Report first/final outcomes, per-slot diagnostics, raw/recovered/formal/semantic layers, repair, actual HTTP, total token, costs, and mean/P95 latency. The complete engineering thresholds and paired statistical procedure are frozen in the Notion protocol. Distinguish full success, partial gains, no reliable gain, and insufficient evaluation capability; fixed-scenario evidence is not proof of population success or long-horizon world realism.

### Budget, persistence, and reporting

The independent additional ceiling is CNY 1000. Reserve CNY 200 for evaluator development/calibration/probes, 200 for discovery compilation, 250 for confirmation compilation, 250 for formal output reviews, 50 for trajectories, and 50 for exceptional costs. All model calls count; evaluation and runtime costs are reported separately. The complete schedule must fit a conservative forecast before main execution; insufficient budget stops rather than reducing the sample or dropping reviews.

Each request binds an immutable account/model/price snapshot and reserves a conservative ceiling before sending. Append and flush a checksummed single-writer journal; missing usage remains reserved and blocks further sends. Never overwrite completed outcomes or silently redraw unknown requests. Reopening checks the protocol, prices, and evidence hashes. Reports are available for every phase and terminal stop, without requiring a completed-experiment marker. Notion publication retries independently from model execution.

## Plan

1. Record authorization, the DeepSeek-only amendment, model/pricing readiness, and research provenance.
2. Establish the versioned budget, evidence protocol, calibration fixtures, and strict calibration gate; verify them before any main-experiment requests.
3. Complete and validate the shared compiler foundation and experimental representations, then freeze inputs and run capabilities, discovery, and gated confirmation.
4. Run trajectory checks, produce complete or stopped reports, and update the linked Notion record after every significant stage.

## Verification

Exercise actual codec round trips, snapshot lifetime, root-to-repair candidate identity, tokenizer/model asset integrity, cache/co-batch invariance, native schema violations, reviewer state and evidence mismatches, invalid and missing usage, unknown-send restart, and report generation before completion. Calibration labels must be backed by controlled assertions. Every independent work unit runs focused tests and `npm run check:fast` before a local commit. No paid main phase is permitted without its preceding gates.

## Evidence

The frozen calibration terminated at its failure gate. The execution record owns the scores, failure classification, model-specific cost ledger index, artifact hashes, and stop recommendation. No discovery, confirmation, or trajectory outcome exists, and this spec remains Approved rather than Implemented.

The implemented preparation surface includes model-bound budget reservations, immutable calibration evidence, strict reviewer validation, lossless JSON parsing, and partial reports. The experimental full-precision encoder has offline cache/co-batch invariance evidence through the shared retrieval algorithm; it is not yet bound into the compiler experiment. Shared compiler recovery, repair candidate pinning, native probes, treatment arms, and new scenarios remain outside the completed surface.

Diagnosis distinguishes output-contract failures from semantic label disagreements. The insufficient-evidence projections conflate information missing from an evaluation packet with an output making an unauthorized addition; their low agreement cannot be attributed solely to reviewer capability. Frozen labels and scores remain intact. Any subsequent evaluator development must resolve this boundary on development data and use a new sealed holdout, rather than reinterpret this run as a pass.
