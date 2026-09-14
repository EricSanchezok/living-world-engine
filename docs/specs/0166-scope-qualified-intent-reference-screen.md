# Scope-Qualified Intent Reference Screen

Artifact-Version: 1
Status: Approved

## Intent

Test whether separating an intention's local target vocabulary from the global planning output vocabulary reduces unsupported target selection. This serves the [complete-player objective](0122-player-action-efficiency.md) without reducing the world, selected work, model context or admissible semantic effects.

## Contract

An isolated planning request adapter presents the complete [indexed intention embedding](0161-agent-intent-program-screen.md) with named local target symbols instead of numeric targetIndices. Each symbol denotes an ordinal parameter within its originating action, never a canonical world entity or a planning-table index. A request-level domain table binds those parameters to each original action's ordered local targetRefs and actorRef. Identical intention text used by different actors retains separate action domains; text equality cannot choose an owner. Missing or multiple canonical bindings retain the original source evidence and are not resolved by this view.

Every recognized copy of a source intention in the request receives the same parametric syntax view, including activity and reference descriptions. Complete node order, root, child links, conditional text, repetitions, waits, concurrency, exact leaf text and target order survive. The adapter verifies restoration of the full source context and rejects input mutation before response validation. It leaves the output schema, canonical validator, effects, means, batch cardinality, repair count and source identities intact. The view interprets syntax only: it grants no execution authority, evaluates no condition and produces no world change. Ordinary text and malformed program-like strings retain their original values.

Only programs found in source action records with an exact supported embedding and validated local target domain are eligible. Other strings remain plain text. If any action uses the same text without a valid domain, that text remains opaque in every copy; a program-looking player utterance cannot acquire a different actor's bindings through text equality. An eligible exact copy elsewhere can reuse the parametric view without selecting an actor. Program recognition, domain verification and source restoration are deterministic. The adapter does not infer that a supplied intention is reasonable or true, and does not rewrite the stored action or canonical world.

## Plan

Keep the adapter and its screen in the benchmark layer. Apply it to complete logical planning contexts before their existing physical codecs and preserve original request evidence. Compare the same frozen meter-repair counterexample with precise diagnostics in both arms; C adds only the local symbol view. Pin code, source, codec and physical requests before fresh model calls. The historical failed candidates remain evidence and never become game state.

## Verification

Exercise nested sequence, parallel, if, while and await; repeated text under distinct actors; absent and multiple identity bindings; duplicate or dangling local target domains; ordinary text; source mutation; and exact restoration of every altered copy. Pass accepted and rejected recorded outputs through the actual gateway and TruthEngine before paid dispatch, including correctly bound synthetic seed audits and complete billable transport accounting. A fixed paired screen must inspect actual effect targets and whole-plan relevance after mechanical admission. No success-rate generalization, production promotion or sixty-second claim follows from mechanical admission; a fresh complete forty-nine-subject player action remains the final requirement.

## Evidence

[Codec and real-entry tests](../../src/engine/benchmarks/step-efficiency/intent-local-reference-view.test.ts) own complete-source restoration, local binding and canonical repair evidence. [Decision 0212](../decisions/0212-separate-intent-and-planning-reference-domains.md) owns the scope-preservation rationale and alternatives.
