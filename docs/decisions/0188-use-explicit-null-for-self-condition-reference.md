# Use Explicit Null for Self Condition Reference

## Status
Accepted
Class: testing

## Context and Problem Statement

A newly created Condition is named by a resolution effect's proposalKey. Asking a model to repeat that spelling in conditionRef introduces a second selection even when both fields express one declaration. Original reference validation must still reject unknown explicit keys and preserve legitimate references to existing Conditions or other declarations.

## Decision Drivers

- Remove a dependent copy without selecting world semantics.
- Preserve the full original reference vocabulary and downstream validation.
- Keep malformed historical references visible and test the generated convention independently.

## Considered Options

- Repeat the declaration key with stronger instructions.
- Use explicit null as the current effect's declaration reference.
- Introduce a separate declaration table and index.
- Correct unmatched keys or infer intended Conditions from descriptions.

## Decision Outcome

Select the benchmark-only contract in [0135](../specs/0135-self-condition-generation-reference.md). Explicit null identifies the containing declaration. Explicit non-null values remain unchanged. The original validator, rather than the codec, decides whether a supplied reference is valid. This adds no inferred semantic choice and makes no claim about correct target ownership or complete gameplay.

## Pros and Cons of the Options

### Repeated key with instructions

Preserves the existing wire vocabulary but retains the duplicate spelling dependency and its repair cost.

### Explicit null for self reference

Eliminates the copy while keeping existing and cross-declaration references expressible. It requires a versioned decoding convention and empirical evidence that the model uses it correctly.

### Separate declaration table

Can share declarations but adds another join and reference domain to every generated plan.

### Corrected or inferred references

Can conceal malformed output by changing the supplied choice. It does not preserve the model's explicit declaration and is excluded.

## Links

- [NatSQL](https://aclanthology.org/2021.findings-emnlp.174/) motivates simplifying generated intermediate representations while preserving expressiveness. Its SQL inference rules and performance claims do not establish this adapter's correctness or efficiency.
- [Dependent resolution fields](../specs/0135-self-condition-generation-reference.md) defines the specific generation experiment and its validation boundary.
