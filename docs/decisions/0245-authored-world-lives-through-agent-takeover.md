# Authored world lives through Agent takeover

## Status

Accepted
Class: feature

## Context and Problem Statement

The Cyberpunk world needs distinct playable lives with assets, occupational authority, contracts and reciprocal acquaintances. Origin descriptions and numeric profiles initialize a new person's basic state, but relationship hooks do not instantiate this wider social state. Existing control transfer can preserve a fully authored Agent and its world relationships.

## Decision Drivers

- Make starting advantages and obligations executable and inspectable.
- Keep one identity per person and preserve private cognition.
- Ship world content through the current engine without franchise-specific behavior.
- Retain independent lives for identities the player does not select.

## Considered Options

- Use descriptive Origin hooks with numeric initialization alone.
- Extend the generic Origin contract with atomic social and asset templates.
- Author complete existing Agents and enter through observer creation followed by takeover.

## Decision Outcome

The Cyberpunk world uses authored Agents and existing takeover. Ordinary schema-v17 entities, quantities, facts, goals and belief bindings establish each life before control changes. Deterministic authoring sources generate the runtime directory and provenance catalogs. The world does not advertise new-person Origins that omit the promised relationships.

This content choice does not change the framework contract. The entry uses pre-existing names and does not offer free-form name or appearance customization. Unselected lives remain model-controlled. Startup and takeover require no model inference; subsequent action semantics retain the existing model and transaction boundaries.

Shared funds use bounded payment-service Agents that hold the actual account quantities and act under authored mandates. The world selects the additive `decision-deepseek-long` fallback profile with a 32,768-token output ceiling. A recorded crowded opening exhausted an 8,192-token response entirely in reasoning after the primary provider rejected its token volume. This reserves answer capacity without shrinking the scene or changing the other worlds' profiles; it permits greater fallback output cost. Qualifying evidence and its limits belong in the world verification report.

## Pros and Cons of the Options

- Descriptive hooks are inexpensive but cannot establish reciprocal memories, asset ownership or restricted project funds.
- Generic initialization templates support new identities and customization, but need a separate approved contract covering identity substitution, atomicity and repeat application. They are not necessary for the selected content entry.
- Existing takeover preserves complete authored state and already has a public entry path. It requires a two-stage entry and pre-existing playable identities, and introduces additional autonomous characters into the world.

## Links

- [World content and provenance](../../worlds/cyberpunk2077/authoring/README.md)
- [Playable entry tutorial](../../worlds/cyberpunk2077/play.md)
- [World schema](../../src/script/contract.ts)
- [Control transfer implementation](../../src/server/world-host.ts)
- [Persistent world acceptance](../../test/cyberpunk2077-world.test.ts)
