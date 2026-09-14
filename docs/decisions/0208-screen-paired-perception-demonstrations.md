# Screen Paired Perception Demonstrations

## Status
Accepted
Class: testing

## Context and Problem Statement

A valid perception report may still turn a future delivery into current knowledge or delay an independent question behind unrelated work. Explicit branch instructions and alternate output representations do not establish the intended source interpretation. Paired input/output cases can expose how a small change in evidence changes the answer while retaining the actual task.

## Decision Drivers

- Preserve the complete world and open action semantics.
- Isolate semantic task demonstrations from schema and context changes.
- Include positive visibility, absence of access and consequential uncertainty.
- Keep development cases separate from independent evaluation.

## Considered Options

- Add another prose decision table.
- Add fixed authored semantic demonstrations.
- Retrieve examples with a trained similarity encoder.
- Replace free-form semantics with an authored operator language.

## Decision Outcome

Use the isolated [paired demonstration screen](../specs/0162-paired-perception-demonstration-screen.md). Append the eight-case asset to the system prompt and bind its hash into the experimental prompt version. Keep original schema, full context and canonical validators.

## Pros and Cons of the Options

A prose table is compact but supplies no concrete example of how the input and answer change together. Fixed demonstrations provide those contrasts without another online call; they increase input and can bias predictions or encourage copying.

Retrieval can select relevant examples but requires a separately curated dataset, encoder and evaluation. The diagnostic has no retrieval implementation and makes no KATE performance claim.

An operator language offers stronger semantics only with valid authored preconditions and effects. Making it the sole action language narrows open-world coverage beyond this screen.

## Links

- [What Makes Good In-Context Examples for GPT-3?](https://aclanthology.org/2022.deelio-1.10/) motivates sensitivity to example selection. Sections 1–2 describe KATE's nearest-neighbor selection from training examples; these GPT-3 benchmark results do not establish effectiveness for DeepSeek or world simulation.
- [Transition interval demonstrations](../specs/0058-transition-interval-demonstrations.md) target another stage and representation.
- [Perception example omission](../specs/0126-perception-example-diagnostic.md) isolates the transport's generated shape example rather than annotated semantic cases.
