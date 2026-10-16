# Grouped perspective reading with auxiliary relationships

## Status
Accepted
Class: feature

## Context and Problem Statement

The perspective combines exact mechanics, quantities, containment, known entities, beliefs and personal intentions. A graph-first workspace gives every structure equal visual weight, represents intentions as believed relationships, and requires fitting increasingly dense graphs into a modal. A separate mobile relationship list omits the entity detail and evidence entry points.

## Decision Drivers

- Keep the existing engine-owned, cognitively isolated perspective as the only source.
- Make state, belongings, intentions and known information directly readable.
- Preserve full descriptions and evidence on narrow screens and with keyboard navigation.
- Keep arbitrary world predicates and mechanics generic.
- Avoid duplicate detail implementations and repeated intention prose.

## Considered Options

- Retain the graph-first workspace with a separately maintained mobile list.
- Remove relationship visualization entirely and use only grouped reading.
- Use shared grouped reading with an optional focused relationship graph.

## Decision Outcome

Choose shared grouped reading with an optional focused graph. Status, items, goals and known information carry the primary reading flow. Native disclosures expose details and evidence through the same component on every viewport. Goals and commitments remain personal intentions, separate from factual and epistemic edges. The graph uses the same perspective, opens on demand, shows direct relationships around a selectable object, and navigates back to the existing detail entry. Layout and disclosure state are local UI state; the API, persistence and cognitive boundary remain unchanged. The current presentation contract is defined in the linked product reference.

## Pros and Cons of the Options

### Graph-first workspace

- Good: spatial relations are visible immediately.
- Bad: automatic fitting reduces text legibility; long details distort graph geometry; the mobile alternative duplicates presentation and loses detail access.

### Grouped reading only

- Good: one simple reading order handles narrow screens and long descriptions.
- Bad: removes useful spatial exploration of open relationships.

### Grouped reading with an auxiliary graph

- Good: readable defaults, shared details, clear intention semantics and optional spatial exploration.
- Bad: exploring relationships takes an extra interaction; a focused graph requires changing focus to inspect more distant connections.

## Links

- [Presentation reference](../game-design/presentation.md#视角-hud)
- [Unified Agent Perspective](0068-unified-agent-perspective.md)
- [Perspective workspace](../../src/app/_components/agent-perspective-workspace.tsx)
- [Reading regressions](../../src/app/_components/agent-perspective-content.test.tsx)
