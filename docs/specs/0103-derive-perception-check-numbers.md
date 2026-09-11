# Derive perception check numbers from existing rules

Artifact-Version: 1
Status: Approved

## Intent

Apply the existing [open semantic resolution contract](0001-open-semantic-resolution-v10.md) to onset perception under the continuing non-thinking gameplay optimization authorization. A model chooses supported difficulty and aptitude; the engine owns the numeric consequence of those choices.

## Contract

Perception requests select a named environmental difficulty with an existing evidence source, or an opposed difficulty with an existing target-owned Rating and that Rating as its source. The optional observer Rating must belong to the observer. The engine derives DC and modifier from the same rules used by action resolution and includes the selected observer Rating exactly once. Model-authored DC, modifier and modifierSources fields are invalid; there is no legacy decoder or numeric correction fallback.

Existing observer, target, stakes, visibility, causal evidence, roll mode, focused task assignment and request/continue protocol remain explicit. Full action and state evidence, repair limits, RNG identity and atomic commitment remain intact. Invalid numeric evidence fails before randomness. Difficulty-source existence and ownership establish mechanical validity, not a sensory route or semantic correctness. Neither named difficulty nor a successful roll certifies that a check was justified; completion-only responses still require independent coverage evidence.

The entity being perceived and the entity supplying an opposed Rating remain separate explicit choices. An object concealed by someone else does not become that person's identity when difficulty is derived; both references must exist and the opposed Rating must belong to the declared opponent.

Persisted check requests retain the existing derived numeric form. Original model drafts and their selected difficulty evidence remain in request/response audit artifacts. The onset-perception algorithm version is 2; the model schema and perception prompt version identify its producer contract. No saved check is rewritten and the old producer is not registered.

## Plan

Share difficulty validation and numeric derivation with resolution, reuse the existing model difficulty schema, and update perception materialization and field instructions. Remove raw numeric output fixtures and replace them with explicit rule selections. Record the escaped numeric-authority failure separately from experimental performance.

## Verification

Exercise the real perception entry for all five environmental bands, opposed target ownership and exact source matching, observer Rating changes and null aptitude, nonexistent evidence, repeated mechanical sources, and attempted raw-number injection. Compare clean and repaired executions to prove identical check identities and RNG outcomes, no source mutation and no draws for rejected requests. Retain full-step reaction and replay coverage, resolution tests and check:fast. Freeze deterministic semantic controls and fresh model comparisons independently; this engineering unit does not establish the complete gameplay goal.

## Evidence

[Perception entry tests](../../src/engine/mechanics/__tests__/perception-references.test.ts) and [resolution tests](../../src/engine/mechanics/__tests__/resolution.test.ts) own mechanical verification. [The incident report](../postmortems/0107-perception-raw-numeric-authority.md) records the observed DC and aptitude failure.
