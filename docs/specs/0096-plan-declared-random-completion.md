# Plan-declared random completion

Artifact-Version: 1
Status: Approved

## Intent

Avoid a separate model request that only ends random commitment planning when the original planner can make that decision with its complete input. This optional experiment follows the authorized full-step efficiency objective. It changes model-visible behavior and requires fresh live validation; deterministic tests alone do not establish gameplay success or latency.

## Contract

Each initial plan explicitly declares additionalRandomness as none or defer, scoped to its original action and current component. The planner retains the full state, authored distributions, source actions and rules. None means no additional discrete random request is needed for that action, including its interactions in this component; it does not mean the action succeeded or finished. Defer preserves the existing result-dependent continuation path.

The engine may finish commitment planning only after complete initial action coverage, mechanical plan validation and the existing independent plan review accept, every declaration is none, and no check or random commitment round exists. Logical plan retries, targeted repairs and plan-review repairs disable early completion. Statements are consumed only within the same preparation closure and never inherited by a repaired plan or another component. Missing or malformed statements fail the selected schema; they never default to none. Physical regeneration must produce a fresh complete statement bound to the accepted plans.

The selected output schema carries declarations through the existing physical batch and reversible planning codecs. Batch grouping separates distinct logical schemas. Canonical plans, receipts, random stream acquisition and release, transition generation, observation and causal review retain their existing contracts. The experiment does not infer completion from automatic mode, remove distributions, reduce action cardinality, change inference settings or fabricate a model invocation. Default Compositions remain unchanged. The declaration prompt and schema are pinned in the optional Composition setting.

Transition materialization resolves random request and step handles against the same committed random request collection exposed in the model context. Existing result assertions must match the actual draws; accepting a declared handle does not relax causality or permit redraws during transition repair.

## Plan

Add the declared-plan schema and prompt, propagate the selected logical schema through physical batching, and expose the option through the indexed reviewed Composition and existing experiment runner. End the commitment loop after accepted receipts only when the full eligibility predicate holds.

## Verification

Exercise real TruthEngine preparation with model HTTP replaced: explicit none, defer with actual discrete draws, checks followed by continuation, logical and targeted repair invalidation, independent component decisions, and unchanged state, plans, receipts and random stream against the original path. Exercise the real batch collector and complete planning codec chain with distinct schemas and per-action declaration ownership. Run relevant tests and check:fast. Freeze a live comparison including random-required counterexamples before claiming model or gameplay gains.

## Evidence

Implementation and regression evidence belong with [the completion contract](../../src/engine/mechanics/plan-random-completion.ts). The [ordered stream contract](0073-release-random-stream-after-commitments.md) remains authoritative for random ownership. [Decision 0156](../decisions/0156-declare-random-completion-with-plans.md) records the alternative tradeoffs.
