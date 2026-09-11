# Action Compilation first-pass experiment

Artifact-Version: 1
Status: Approved

## Intent

Execute the user-selected AC-FP1 protocol against existing captured gameplay. Improve first-pass semantic compilation without reducing open-action expressiveness, world mechanics, candidate membership, or physical batch sizes. The user authorizes DeepSeek expenditure up to CNY 1,000; the experiment must also enforce the protocol's smaller request and token limits.

No new FullCatalog labels, benchmark expansion, model switch, production default promotion, instance migration, implicit fallback, or automatic publication is included.

## Contract

### Sources and controls

Use the four schema-v2 captures from execution `dec46f38-a50b-4a28-85d6-73f95a9405fb`: original batches of twelve, twelve, twelve, and seven actions. Validate complete provenance, state, actions, catalog, full context, model context, and candidate memberships before provider work. The source database is read-only. The immutable v1 retrieval dataset remains a retrieval regression rather than a semantic gold standard.

B1 fixes entity-valued fact assertion materialization and the inconsistency between displayed repair candidates and the repair resolver. Independent regression tests establish both fixes before protocol treatments. B0 remains historical evidence, not a duplicate production implementation.

### Treatments

The action-compilation AlgorithmRef explicitly identifies canonical B1, reversible short-reference A, conditional temporal representation T, or their combination AT. All share the production compiler, R5 candidate selection, materialization, validation, original profile/inference, batching, and recovery. Model-visible prompt/schema/codec versions participate in experimental identity. Treatments do not alter the host default.

A maps the root-batch visible candidate union, sorted by canonical key, to `r` plus a zero-padded decimal ordinal with width `max(3, digits(N-1))`. The bijection is stable across repair, while permissions remain tied to the original action and slot. Only schema-defined symbol positions change. Unknown or cross-slot aliases fail; short aliases never use fuzzy correction. Canonical references remain available in local audit evidence.

Implementation clarification before live execution: historical repairs select 139–207 keys outside their initial shortlist, all already in the full root catalog. After assigning the initial visible ordinals, reserve the remaining full-root keys in sorted order as a private namespace tail (the initial width is a minimum, never renumber earlier aliases). Only the current R5-selected catalog is serialized. This supports the unchanged repair/retrieval contract without exposing the full catalog or restricting later selections; keys outside that root universe still fail closed.

T represents a conditional profile's nonempty assertion list as `{ first, rest }`, selected by script-owned profile semantics. Decoding restores the complete ordered assertion list. Nonconditional profiles preserve every previously legal assertion list. All assertion variants, values, dependencies, causes, quantities, claims, and audiences remain expressible. No condition or action is inferred by a deterministic default merely to satisfy structure.

Profile semantics come from the engine's captured script definitions, not from optional projected candidate details. The adapter does not expand those details or alter the R5 context to construct its conditional schema.

For every legal B1 compilation, treatment encode/decode preserves the full canonical compilation. Applying the restored compilation through the real mechanics and kernel preserves semantic world trajectories. Failed schema/reference checks never mutate the source. A syntactically accepted but intent-incorrect response is not semantic success.

### Execution and accounting

The experimental entrypoint calls real compileActions and ModelGateway; a prompt-only invocation probe is insufficient. Discovery uses four sources, four arms, and four repetitions. Confirmation uses four sources, B1 plus the sealed winner, and sixteen fresh repetitions. Ordering, source manifests, prompts, schemas, analysis, and intent oracles are sealed before live work. No failed trial is discarded or redrawn.

Count every actual HTTP request, including repair, splitting, and transport retry, before sending. Enforce discovery/confirmation limits of 200/400 HTTP requests and known-total-token stop lines of 8M/16M. A persistent reservation ledger additionally enforces CNY 1,000 at conservative verified rates; missing usage or unreconciled in-flight calls stop subsequent work. Credentials are only consumed through the normal provider configuration, never copied into reports.

The experiment root is separate from the game database. Content-addressed source/configuration artifacts, raw requests and responses, call trees, verdicts, costs, and resumable progress remain inspectable. Atomic publication validates hashes; incomplete runs are reported as incomplete, never passed. Offline is the default and live execution requires an explicit flag and recorded authorization.

### Semantic evaluation

Freeze must/may/forbidden intent constraints for all forty-three actions before observing treatment outputs. Accept multiple semantically valid compilations, not just historical candidate selections. Independent scoring cannot inject additional model repairs or give an arm a hidden correction. Unresolved intent judgments do not count as success and block promotion claims.

Report raw and normalized first-pass whole-batch success, first-pass slot success, transport-free success, terminal success, repair recovery/exhaustion, token breakdown, actual HTTP requests, cache usage, latency, and semantic failure classes. Include all failures and per-source strata. Confirmation alone supports the headline comparison; repeated calls on one state are not independent worlds.

The protocol's expressiveness, twelve mechanism families, pre-registered statistical/cost gates, and stopping rules govern the result. Passing this experiment does not authorize changing production defaults or claiming a population-wide reliability guarantee.

## Plan

Freeze source evidence and the protocol, fix and test B1, implement the shared experiment runner and budget ledger, implement versioned A/T codecs, prove offline invariants, then execute discovery and conditional confirmation. Keep an append-only Notion experiment record with problems, deviations, checks, measured cost, and conclusions. Complete each independently verifiable code unit with focused checks and a local commit.

## Verification

Exercise real compileActions for both B1 regressions. Verify alias bijection, all legal assertion branches, exact-only alias decoding, slot isolation, repair identity, out-of-shortlist rejection, and unchanged R5 retrieval. Compare canonical compilations and real world trajectories through temporal, causal, resource, cognition, transaction, and replay tests. Test budget reservation before every send, retries, missing usage, crash recovery, unknown artifacts, drift rejection, incomplete publication, and deterministic scoring.

Run focused tests and `npm run check:fast` per unit. Final checks include algorithm catalog verification, v1 reference verification, relational-RRF production parity, world validation, and build. A new-instance interactive runtime/restart/replay check is required only before a separately authorized production decision.

## Evidence

The [execution reference and coverage map](../../experiments/action-compilation/ac-fp1/v1/README.md) identify the CLI, immutable artifacts and owned regression suites. Actual ModelGateway/compiler tests retain partial validated slots, unknown-reference failures and recovery without an oracle in the runtime. The frozen verification artifact binds deterministic checks to the exact implementation; the linked Notion experiment record owns live measurements and adjudication status. A successful offline test is not evidence of live semantic improvement.
