# Select native context capacity per complete request

## Status

Accepted
Class: architecture

## Context and Problem Statement

Jev offers default request/question limits and an opt-in long-context header. Default-only preflight can divert valid native work to generative fallback before the native provider is called. The complete shared state cannot be made smaller by splitting question IDs.

## Decision Drivers

- Preserve complete semantics and the existing native decision protocol.
- Keep default-mode latency and quality for small requests.
- Make budget admission and physical transport agree, including actual provider overflow.
- Measure gameplay-sensitive differences rather than treating answer agreement as correctness.

## Considered Options

- Retain default limits and immediately fall back to Flash.
- Enable long context for every native request.
- Select native capacity per request, escalating an underestimated default request once.

## Decision Outcome

Choose demand-driven native capacity. A native profile declares its long-context token capacity alongside its default question budget. The shared budget calculation selects the mode from both token estimates and carries it into the adapter and request evidence. Independent operator and byte limits still apply. Actual default-provider overflow permits one intact long-context retry; overflow after that uses the existing explicit fallback. No new provider, independent decision implementation or gameplay rule is introduced.

The choice extends the native admission behavior described in [0269](0269-flash-default-generation-and-task-owned-reasoning.md). Publication routing remains independently qualified; supporting native long context does not establish that native publication checks match the existing acceptance contract.

Capability support does not imply bundled activation. The [recorded gameplay qualification](../research/2026-10-19-jev-long-context-qualification.md) identifies semantic regressions in long-context world judgments, so the bundled profile does not declare this capability. Quality remains the activation condition rather than a latency-only threshold or an extra model checking every native answer.

## Pros and Cons of the Options

- Immediate Flash fallback is simple but bypasses an available native capability and generates reasoning output for closed judgments.
- Unconditional long context has simple admission but exposes small requests to an unnecessary experimental mode.
- Demand-driven capacity preserves default mode and complete batches, with explicit additional admission state. Native estimates can still be wrong, and long contexts need semantic qualification: the provider documents slower and less accurate behavior than within default limits.

## Links

- [Approved contract](../specs/0208-demand-driven-jev-long-context.md)
- [TypeSafe context limits and long-context header](https://docs.typesafe.ai/models#long-context)
- [Model gateway](../game-design/model-gateway.md)
