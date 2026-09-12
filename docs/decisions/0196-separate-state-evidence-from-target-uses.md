# Separate state evidence traversal from target output uses

## Status

Accepted
Class: architecture

## Context and Problem Statement

The relational retriever propagates actor or target roles along graph paths. Its target predicate requires each visited candidate to support a target output use; the actor predicate permits agents, entities or subject uses. Quantities and ratings can be valid evidence about a selected entity without satisfying these predicates. Budget-only alternatives do not establish source-semantic improvement, so evidence-path eligibility needs an isolated test.

## Decision Drivers

- Distinguish evidence retrieval from permission to author a canonical output reference.
- Preserve exact source bindings, slot visibility, temporal boundaries and fixed cost ceilings.
- Inspect the actual ranking path without a second graph implementation.
- Keep empirical relevance and player acceptance separate from graph reachability.

## Considered Options

1. Admit matching typed entity-state edges for actor and target paths in an explicit experimental policy.
2. Remove all role constraints from graph traversal.
3. Require the complete state closure of every anchored entity in the shortlist.
4. Change candidate allowed uses so inventories and ratings can act as targets.

## Decision Outcome

Select the first option as an isolated experiment under [Spec 0144](../specs/0144-typed-state-support-paths.md). The shared physical retriever supplies both the default and experimental policy, with opt-in path snapshots for diagnosis. The default field-use-constrained traversal remains selected. Canonical candidate uses, authoritative validation and the allocation policy retain their own contracts.

## Pros and Cons of the Options

1. Tests a precise source-relation mechanism and adds no model calls or candidate budget. More graph evidence can still displace relevant candidates; an attached state is not necessarily relevant to this action.
2. Broadens several mechanisms together, making it harder to attribute changes and potentially crossing profile-role boundaries unnecessarily.
3. Retains attached evidence but can exhaust or exceed the current budget before compact domains and non-anchor evidence compete. It confuses ownership with action relevance.
4. Changes what a model may propose merely to accommodate an internal ranking rule; this weakens the separation between retrieval and semantic output validation.

## Links

- [GraphRAG local search](https://microsoft.github.io/graphrag/query/local_search/): entities serve as access points to related evidence, which is then ranked within a context budget. This is a design analogy, not evidence of game correctness.
- [Relational RRF promotion](0100-promote-relational-rrf-and-refresh-reference-data.md).
- [Rank allocation comparison](0195-evaluate-rank-balanced-retrieval-budget.md).
