# Subject-Scoped Condition Creation

Artifact-Version: 1
Status: Implemented

## Intent

Avoid global readjudication caused solely by a newly allocated condition ID under an already-declared affected subject. The standing user authorization permits algorithm and architecture changes with recorded evidence and checks. This change retains the existing grounding contract: dependencies name existing objects, while the kernel owns future record creation.

## Contract

A condition absent from the input snapshot may be created within a component only when its subject exists in that snapshot and that component explicitly declares the subject as an entity write. An entity read, placement write, or a write to a different subject does not authorize creation. Existing conditions continue to require their exact condition write keys. Other operation families retain their existing rules.

Creation also occupies a conservative subject scope. Before merging independently adjudicated components, compare each created condition's subject with other components' declared entity, placement and condition references, their actual entity accesses, and the old and new subjects of their condition operations. A same-subject access forces global readjudication even when the other component emits no operation. Duplicate new IDs across subjects remain ordinary write conflicts. A global dependency conflicts with every creation. These checks also run after final candidate repair; a newly introduced conflict then fails without committing.

The scope check does not grant semantic correctness or change condition effects, causal review, RNG, observation rules, component cardinality, model outputs, or canonical commit validation. The initial graph and dependency declarations stay intact; a late scope collision retains conservative fallback rather than silently merging stale interpretations.

## Plan

Add fresh-condition coverage and the paired scope check to the existing dependency validator. Pass both components' fixed declarations at initial merge and final-repair validation. Exercise the actual scheduler and committer with an independently declared condition effect before a fresh complete player diagnostic.

## Verification

Verify successful independent-subject creation, unknown subjects, read-only permission, wrong-subject permission, existing-record overwrite, duplicate IDs, same-subject readers without deltas, existing-condition readers, condition replacement and removal, and final-repair validation. Replay recorded structural failures without network and label that evidence separately from full execution. Run focused tests and check:fast before the local commit.

## Evidence

The [dependency validator](../../src/engine/mechanics/action-dependency.ts) owns coverage and conflicts; the [scheduler](../../src/engine/algorithms/eager-reference/eager-reference.ts) owns merge and repair validation. [Boundary tests](../../src/engine/mechanics/__tests__/condition-creation-dependencies.test.ts) check coverage and competing accesses. [Complete engine regressions](../../src/engine/algorithms/eager-reference/__tests__/condition-creation-scope.test.ts) verify committed conditions, replay, unchanged RNG, required fallback and final repair. The [decision](../decisions/0200-cover-condition-creation-with-subject-scopes.md) records the concurrency tradeoff.
