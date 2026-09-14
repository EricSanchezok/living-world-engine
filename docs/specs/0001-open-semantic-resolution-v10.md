# Open semantic resolution v10

Artifact-Version: 1
Status: Implemented

## Intent

Replace model-authored raw difficulty and impact numbers with a general effect-oriented contract that combines open natural-language actions with deterministic numeric settlement. The engine must support improvised means, persistent equipment, combat and non-combat effects, temporary semantic conditions, replayable randomness, and script-defined numeric curves without introducing Weapon or Armor core classes.

Schema v10 is a forward-only boundary. Schema v9 worlds, states, saves, fixtures, `core-d20@1.1.0`, and its `apply-meter-impact` path are outside the live contract and receive no migration or compatibility reader.

## Contract

The shared vocabulary is `none | minor | standard | major | decisive` magnitude, `exceptional | full | mixed | miss` outcome, `safe | risky | dire` risk, and `automatic | check | blocked` resolution mode. Before any resolution randomness, Truth commits a `ResolutionPlan` containing the action goal, actor, targets, grounded means, factors, difficulty or opposition, risk, primary effect, optional weaker secondary effect, and threatened consequence. Every factor cites canonical evidence and uses exactly one role.

The default check is d20 plus at most one actor-owned aptitude Rating. Named environmental difficulties map to DC 5/10/15/20/25; opposed checks use 10 plus one target-owned Rating. Semantic edges and hindrances select advantage, normal, or disadvantage and never add arbitrary modifiers. Margin produces exceptional at 10 or more, full at 0 or more, mixed at -5 or more, and miss otherwise; a kept 20 upgrades one grade and a kept 1 downgrades one grade.

Settlement is deterministic from the committed plan. Exceptional upgrades the primary intended effect one magnitude, full and automatic apply intended effects as planned, mixed downgrades intended effects one magnitude and applies the mixed risk consequence, and miss applies only the miss risk consequence. Safe consequences are none/minor, risky consequences minor/standard, and dire consequences major/decisive for mixed/miss respectively.

Each action-target-channel has one primary impact and at most one secondary impact at least one magnitude lower. [Evidence annotation and mechanical source ownership](0171-evidence-annotation-source-ownership.md) define source reuse. Only grounded means participate, and net potency/protection shifts are clamped to two magnitude steps in either direction. A source used for a secondary effect cannot also increase the primary effect.

`ConditionState` stores a subject, open semantic label and description, magnitude, named duration profile, visibility, and causal provenance. Conditions need no predefined type. Declared condition profiles may add a stacking key, deterministic recurrence, recovery, or thresholds. Reapplying the same condition or stacking key replaces it when stronger, steps it up when equal, and otherwise refreshes duration.

World mechanics declare impact profiles, duration profiles, optional condition profiles, entity mechanics profiles, and adjudication calibrations. Impact profiles map magnitude to Meter delta and clamp bounded impacts before threshold processing. Runtime numeric writes are rule-derived: model transitions cannot directly submit DCs, modifiers, Meter deltas, Condition magnitudes, or Rating values. Quantity amounts originate only from explicit action text, existing state, committed random results, or trusted rule results. Numeric Facts are inert unless a declared derivation consumes them.

One-step improvised means may cite an Entity, Fact, Condition, placement, location description, or law without becoming an Entity. Anything independently persisted, transferred, placed, damaged, quantified, or targeted is an ordinary Entity. Important authored equipment may carry Ratings or trusted rule annotations, while unannotated content uses semantic adjudication plus independent causal verification.

Committed history stores `ResolutionPlan` and `ResolutionReceipt`; replay validates and consumes the receipt without model readjudication. Full player visibility includes factors, named bands, roll, grade, and visible changes; worlds may choose result-only or hidden visibility. Agent cognition and hidden canonical evidence remain isolated. The trusted local Inspector always receives the complete receipt.

Blackmarsh keeps vitality 0..30 and maps harm and recovery to 2/5/10/30 for minor/standard/major/decisive. Its Origin uses an entity mechanics profile so a newly admitted participant receives vitality and Ratings as well as quantities. Its calibrations cover improvised clubs, swords, enchanted and flaming weapons, armor, sand, dangerous relic contact, healing, locks, pursuit, influence, trade, and progress.

## Plan

Add the v10 engine contracts and trusted `core-resolution@2.0.0` package, integrate planning before resolution commitments, derive and commit effects through the existing transaction and causal boundaries, then update script loading, admission, replay, projections, Inspector evidence, Blackmarsh, and the current reference documentation. Remove the v9 and `apply-meter-impact` implementations as each replacement becomes live.

## Verification

Exercise the real ground-to-commit-and-replay entry path and prove named-band mapping, outcome grading, factor ownership, source deduplication, effect combination, condition stacking, Meter clamping, threshold firing, numeric provenance, participant admission, visibility, and cognitive isolation. The scenario corpus compares club, sword, flaming sword, armor, multiple carried weapons, sand with and without environmental support, dangerous relic contact, and representative non-combat actions.

Run `npm test`, `npm run world:validate -- worlds/blackmarsh/world`, `npm run build`, `npm run check:fast`, `node scripts/run-gates.mjs`, and `git diff --check`. No verification requires starting the server or importing a world.

## Evidence

Implemented by the following independently verified commits:

- `8af88d6` — Approved this Spec and recorded ADR 0067.
- `e3fd055` — Added the deterministic semantic resolution core.
- `98b1aa3` — Published strict schema v10 and upgraded Blackmarsh.
- `4f2651b` — Integrated pre-random plans, receipts, trusted settlement, projections, Inspector evidence, and replay.
- `fb8072e` — Closed semantic review gaps, including the independent pre-random plan verifier, reaction re-grounding, RNG transcript replay, numeric provenance edges, and cognitive-isolation checks.

Final verification passed on 2026-08-27:

- `npm test`: 28 test files and 162 tests passed.
- `npm run world:validate -- worlds/blackmarsh/world`: 232 entities and 48 Agents validated.
- `npm run world:validate -- test/fixtures/open-world-script`: 5 entities and 2 Agents validated.
- `npm run build`: the production Next.js build completed successfully.
- `npm run check:fast`: lint, typecheck, tests, fixture validation, workflow verification, and all six governance gates passed.
- `git diff --check`: passed.

Verification did not start a server or import a world.

Primary permanent evidence lives in [`resolution.test.ts`](../../src/engine/mechanics/__tests__/resolution.test.ts), [`resolution-pipeline.test.ts`](../../src/engine/mechanics/__tests__/resolution-pipeline.test.ts), [`agent-resolution-receipt.test.ts`](../../src/engine/runtime/__tests__/agent-resolution-receipt.test.ts), and [`eager-reference.test.ts`](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts).
