# Align the DeepSeek account with bounded process concurrency

## Status

Accepted
Class: architecture

## Context and Problem Statement

Independent world decisions, character actions and narrative publication share one fair model scheduler. A lower account ceiling can leave process capacity idle while a completed world's dialogue waits behind other worlds. Raising concurrency cannot shorten the provider's computation for an individual large decision request.

## Decision Drivers

- Preserve complete questions, evidence, inference settings and per-action call counts.
- Bound process load and maintain fair, cancellable workload queues.
- Separate queue delay from provider duration when evaluating live play.
- Keep the catalog pinned for every saved instance.

## Considered Options

- Keep the DeepSeek account ceiling at four requests.
- Align the account ceiling with the existing sixteen-request process ceiling.
- Raise process concurrency toward the provider's published maximum.
- Disable reasoning or split decision batches to reduce apparent latency.

## Decision Outcome

The DeepSeek account uses a concurrency ceiling of sixteen, subject to the existing sixteen-request global ceiling. Queue capacity, queue timeout, fair scheduling and transport retry rules remain unchanged. This is a bounded scheduling choice, not a claim that sixteen is optimal or that provider inference is faster. The provider documents a substantially higher account limit for Flash; the application does not attempt to consume that capacity. Catalog changes create new test instances rather than altering saved producers.

## Pros and Cons of the Options

### Keep four account requests

- Good: limits simultaneous provider work to a small burst.
- Bad: prevents independent tasks from using the process capacity already budgeted for model work.

### Align account and process ceilings

- Good: permits more independent requests while retaining the existing process bound and fair queue.
- Bad: permits larger provider bursts and does not solve slow individual decisions; live verification must report provider errors and queue delay separately.

### Increase the global ceiling toward the provider limit

- Good: admits still more independent requests.
- Bad: lacks evidence for local memory, network and fairness behavior at that scale.

### Disable reasoning or split batches

- Good: may shorten a particular request.
- Bad: changes adjudication behavior or call count; neither is necessary to remove the account bottleneck.

## Links

- [Model Gateway](../game-design/model-gateway.md#调度失败与审计) — scheduling, catalog and failure contracts.
- [DeepSeek rate limits](https://api-docs.deepseek.com/quick_start/rate_limit/) — account-scoped concurrency and HTTP 429 behavior.
- [Night City adjudication profile](0249-night-city-world-adjudication-profile.md) — complete world decision batches and explicit model selection.
