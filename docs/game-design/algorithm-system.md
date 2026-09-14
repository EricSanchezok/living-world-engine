# Algorithm system

This reference defines the replaceability boundary for world-execution behavior. The generated [algorithm catalog](algorithm-catalog.md) owns the current inventory; this document owns terminology, composition rules, lifecycle, and the authoring procedure.

## Vocabulary

- A **Role** is a typed behavioral contract and the smallest supported replacement boundary.
- An **Algorithm** is one named, versioned implementation of exactly one Role.
- A **Composition** is a complete recursive tree of Algorithms rooted at `world-execution`.
- A **child slot** is a stable name by which a parent Composition owns another Role, such as `root.actionCompilation.candidateSelection`.
- A **Runtime** supplies infrastructure or holds execution state. It is not behavior identity.
- A **Strategy** is an implementation-internal choice. A strategy becomes an Algorithm identity only after it receives a versioned definition and the contract required by its execution surface.

`bootstrap`, `prepareStep`, and `completeStep` are the three lifecycle methods of the root `world-execution` Role. They are not the complete algorithm inventory: cognition, compilation, candidate selection, grounding, reaction, truth resolution, observation, batching, scheduling, and recovery are child Roles beneath that facade.

## Fixed-kernel boundary

Algorithms propose candidates. The engine retains the only authority to validate and commit canonical state.

Canonical schema validation, reference materialization, authorization, quantities, conservation, random commitments, causality, atomic transactions, replay verification, and mechanisms with one correct result remain fixed runtime or mechanics code. A mechanism becomes a Role only when multiple valid behaviors may exist and substitution does not weaken those invariants.

The engine owns stable execution stages, lifecycle events, and metric semantics. Algorithms receive node-scoped capabilities and instrumentation; they cannot define a second commit path or impersonate another Composition node.

## Recursive identity

Every executable node is persisted as an `AlgorithmRef` containing:

- Role, implementation id, implementation version, and Role contract version;
- explicit JSON configuration with no persisted defaults;
- named child slots containing complete child `AlgorithmRef` values;
- a recursive manifest hash covering the node and every descendant.

Child object ordering does not affect identity. Child slot names, implementation identities, contract versions, configuration, and descendant hashes do. A behavior-affecting change therefore changes the responsible node hash and every ancestor hash through the Composition root.

The registry validates the entire tree before model calls or canonical-state work. It rejects unknown identities, Role mismatches, contract mismatches, missing or additional slots, unknown or non-canonical configuration, hash drift, and reused or incorrectly identified factory instances. Resolution assigns stable paths beginning at `root`.

World instances, experiment variants, Ledger producers, preparations, replay, and the trusted local Inspector all pin or project this recursive identity. Ordinary world APIs do not expose it.

## Standard composition

Relational RRF v2 preserves the mandatory reference union as a budget floor when it exceeds the proportional shortlist budget. Diagnostics report both budgets and floor expansion; ordinary larger catalogs keep the same proportional limit. The root selection remains fixed through repair.

New ordinary instances select the [standard integrated composition](../../src/engine/algorithms/standard-composition.ts), including reversible compilation, relational retrieval, source-indexed reviewed planning, shared transport and source-bound observations. The generated catalog owns the exact tree and settings. Basic composition factories remain explicit controls for tests and research; they are not an automatic fallback. Default adoption does not certify open semantic correctness or continuous-play latency. [The rollout contract](../specs/0121-standard-integrated-execution-composition.md) defines selection and verification.

Persisted instances and replay keep their complete producer identity when the host default changes. Use a new instance to select the current standard. Missing historical definitions fail before execution instead of silently changing a save's algorithm.

## Runtime and benchmark availability

Maturity is catalog metadata and does not enter behavior identity:

- `reference` is the maintained default or control implementation.
- `candidate` is executable through the production Role contract and eligible for explicitly evidenced experiments.
- `diagnostic` is available only for investigation or offline comparison.

The runtime registry contains only implementations that satisfy their production Role contract and resource preflight. Benchmark-only candidate selectors use `benchmark-candidate-selection-v1`; they are independently replaceable inside the offline harness, appear in the generated catalog, and cannot resolve inside an instance Composition. Promotion requires a production-batch adapter, strict configuration, pinned resources, registry conformance, current benchmark evidence, replay equivalence, and experiment activation evidence.

There is no implicit fallback between Algorithms. A missing asset, unavailable definition, invalid output, or contract mismatch fails closed under the identity that was selected.

Truth Role contract 2 exposes resumable, unreviewed transition candidates and bound causal review. The existing `resolve` entry drives the same candidate session through observation rendering and review; finishing candidate generation alone supplies no causal verdict. A rejected transition resumes with its retained plans and random commitments. [The candidate-session contract](../specs/0074-resumable-truth-candidates.md) defines lifecycle and repair ownership.

The source-bound worklist Truth candidate pins its physical codec order, static prompt bundle and temporal evidence policy as one registered planning pipeline. It is selected only by a fresh explicit Composition; source qualification and actual gameplay remain distinct evidence. [The pipeline contract](../specs/0043-registered-worklist-planning-pipeline.md) owns its scope.

The experimental single-magnitude resolution representation wraps the physical provider beneath the existing batch coordinator. It removes only the duplicate output base magnitude and expands it before the shared canonical validators; context, batch membership and settlement remain unchanged. Its codec and prompt identity are pinned by the candidate Composition. [Decision 0112](../decisions/0112-single-magnitude-resolution-wire.md) defines the expressiveness and rejection boundary.

Candidate retrieval preserves selected-record relationships using source-bound read-only snapshot identities for references outside the executable shortlist. Literal nulls and array positions retain their source meaning; the output catalog and slot permissions remain unchanged. [Decision 0115](../decisions/0115-preserve-shortlist-reference-evidence.md) defines the representation and its limits.

## Adding or changing an Algorithm

1. Choose the narrowest existing Role whose input, output, failure, and privacy contract matches the behavior. Add a Role only when the behavior has a genuinely different contract.
2. Define an English kebab-case id, an explicit implementation version, a Role contract version, a strict configuration schema, exact child slots, maturity, and a fresh-instance factory.
3. Keep provider, filesystem, cache, and rule-package access behind declared services. Fixed runtime, mechanics, and cognition modules must not import a concrete Algorithm.
4. Materialize a complete `AlgorithmRef`; do not persist defaults, ambient environment choices, mutable resource identities, or unversioned strategy names.
5. Add contract tests for malformed trees, substitution, behavior, privacy, determinism, failure, and fresh resolution at the lowest boundary that proves the Role.
6. If the implementation is a candidate, produce exact benchmark, resource-preflight, replay, and activation evidence before adding it to an experiment Composition.
7. Regenerate the catalog and update the owning reference or decision when the Role boundary changes.

## Tooling and drift control

```sh
npm run algorithms -- list
npm run algorithms -- describe <role/id@version>
npm run algorithms -- validate [composition.json]
npm run algorithms -- diff <left.json> <right.json>
npm run algorithms -- catalog
npm run algorithms -- catalog --check
```

`list` includes runtime and benchmark-only availability. `describe` reports the definition and its locations in the default Composition. `validate` checks the default and experiment Compositions when no file is supplied. `diff` reports behavior-changing nodes by path. `catalog` regenerates the checked-in inventory from code.

`npm run verify:algorithms` checks generated-catalog freshness, required registrations, benchmark-family coverage, and forbidden concrete imports across fixed runtime, mechanics, and cognition packages. `npm run check:fast` includes that gate.

The architectural rationale is recorded in [0099](../decisions/0099-typed-hierarchical-algorithm-composition.md).

The experimental source-inventory resolution Composition projects existing eligible means sources beside each assigned action, including repair subsets. It preserves all original context and uses the shared model output and settlement paths. [The source inventory contract](../specs/0028-resolution-source-inventory-experiment.md) defines its scope and validation boundary.

Compilation and grounding share [bound-target dependency materialization](../specs/0168-bound-target-dependency-reads.md). It conservatively includes exact original target bindings as entity reads before conflict scheduling and resolution source selection; semantic relevance and write authority remain separate.
