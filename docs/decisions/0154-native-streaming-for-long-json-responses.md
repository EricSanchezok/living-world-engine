# Native streaming for long JSON responses

## Status

Accepted
Class: feature

## Context and Problem Statement

A non-streaming response can deliver headers and a keep-alive newline while withholding generated JSON until completion. A peer closure after an idle interval discards the generation and leaves uncertain billing. The observed closure does not identify the responsible intermediary or establish that streaming prevents recurrence.

## Decision Drivers

Preserve model behavior and action freedom, expose response completeness, avoid repeated paid sends, and test a delivery change independently of semantic algorithms.

## Considered Options

- Increase timeouts or silently retry non-streaming requests.
- Reduce actions or increase model reasoning strength.
- Opt into native SSE delivery while accepting only complete validated results.

## Decision Outcome

Select the optional native SDK streaming path under [spec 0091](../specs/0091-complete-streamed-json-responses.md). Keep the existing JSON-object prompt and canonical parser. Validate complete stream identity, termination and usage separately from model JSON correctness. Reuse a maintained EventSource parser rather than implementing another framing grammar.

## Pros and Cons of the Options

Longer local timeouts do not repair a peer closure; automatic retries add uncertain cost. Smaller batches or stronger reasoning confound the target behavior and violate the experiment's constraints. Native streaming may reduce idle periods during generation without changing model inputs, but adds termination/accounting checks and cannot guarantee network reliability. No partial result reaches the engine and defaults remain unchanged.

## Links

- [DeepSeek keep-alive behavior](https://api-docs.deepseek.com/quick_start/rate_limit)
- [DeepSeek Chat Completions streaming](https://api-docs.deepseek.com/api/create-chat-completion/)
- [EventSource parser](https://github.com/rexxars/eventsource-parser)
- [Interrupted response evidence](../postmortems/0101-interrupted-response-evidence.md)
