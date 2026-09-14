# Generate Structured Intentions at Decision Time

## Status
Accepted
Class: testing

## Context and Problem Statement

An interpreter reconstructing a compound intention can confuse a requested result with a prerequisite, lose simultaneous speech or substitute a different referent. A decision-time producer can choose control flow together with its intended work from its own private evidence. The source is the chosen program itself; there is no earlier action paraphrase to reconcile.

## Decision Drivers

- Preserve open attempts, concurrency, conditional work, waiting and repetition.
- Preserve all private cognition and target ownership rules.
- Avoid another model call just to recover the producer's chosen structure.
- Test generation and source coherence before giving a program execution authority.

## Considered Options

- Continue reconstructing action phases from a historical natural-language action.
- Produce one free-text intention under the existing single-text contract.
- Produce an open intent program at the private decision boundary.
- Introduce a fixed primitive action vocabulary and execute programs immediately.

## Decision Outcome

Use the isolated [intent-program screen](../specs/0161-agent-intent-program-screen.md). The single-text producer is the control. Code validates the tree and local index domain, preserves the whole program through an exact canonical embedding, and exposes initial attempts or unevaluated conditions. It does not infer physical success or authorize world changes. Existing cognition validation remains in the loop.

## Pros and Cons of the Options

Historical reconstruction permits direct paired comparison of the same action but must infer control flow after it was described. Source quotes alone do not validate the resulting prerequisites.

A single text preserves the familiar free-form interface with fewer independent paraphrases. Temporal structure remains implicit and can require repeated interpretation.

A generated program makes ordering part of the original intention, at the cost of a larger output and a new representation. It can still contain unsupported beliefs, poor choices or control-flow mistakes. Its open conditions and attempts lack formal precondition/effect semantics, so a valid tree is not a safe executable plan.

A fixed operator vocabulary can support stronger guarantees with correct authored preconditions and effects. Adopting it as the sole action language would require world-specific coverage and restrict open semantics before qualification.

## Links

- [Single authoritative action text](0177-generate-one-authoritative-action-text.md)
- [Partial-order phase reconstruction](0206-screen-partially-ordered-action-phases.md)
- [GOLOG: A Logic Programming Language for Dynamic Domains, author-affiliated abstract](https://digitalcommons.njit.edu/fac_pubs/16933/) motivates explicit high-level programs backed by an action theory. Only the abstract was read successfully; the PDF text extraction was unreadable. This diagnostic transfers no situation-calculus semantics, interpreter implementation, proof or performance result.
