# Preserve source review semantics with compact references and targeted repair

## Status

Accepted
Class: process

## Context and Problem Statement

The Fanren authoring workflow performs independent source review over complete chapter batches. Repeating source fingerprints in model context and rewriting every judgment after a local validation error increases input and output without adding evidence. Binding accepted reviews to a requested model configuration also causes unnecessary regeneration when the underlying source and semantic requirements remain unchanged.

## Decision Drivers

- Preserve complete source input, every candidate's semantic content, exact citation ranges, and independent source claims.
- Retain source provenance, unresolved issues, and the distinction between source review and runtime approval.
- Bound paid work and reuse verified artifacts without rewriting their original producer identity.

## Considered Options

- Keep complete repeated metadata and full-result retries.
- Shorten source context or omit repeated candidate judgments.
- Use reversible references, validated semantic reuse, and targeted replacement of invalid rows.

## Decision Outcome

Use reversible paragraph handles in model requests and reconstruct exact persisted references locally. Candidate quotations retain their original ranges; the complete source remains present on initial and repair calls. Initial output still covers all candidates, aliases, issues, omissions, and identity relationships. A repair can replace only identified invalid rows; valid rows remain fixed, and the assembled report passes the complete original validator. Unsafe repair targets require a complete response.

Reuse an accepted report only after validating its source bytes, extraction binding, semantic policy, original audit provenance, and current complete output contract. Preserve the report's original identity and audits. Execution settings and transport encoding do not invalidate an otherwise valid semantic artifact. Unaccepted drafts resume only within their original execution identity.

The source-review runner defaults to Flash with low effort, supports a network-free plan, and bounds generation requests across workers. Provider effort controls reasoning behavior without a guaranteed reasoning-token cap. Source review remains editorial evidence, not approval. One gateway transport attempt per dispatch makes that bound observable; failed requests retain evidence for deliberate resumption. These are authoring execution choices under the [approved authoring contract](../specs/0196-canonical-world-and-participation-seeds.md), without changes to runtime authority or world approval.

## Pros and Cons of the Options

Full-result retries are simple but repeat unaffected output and allow valid judgments to drift during repair. Shortening source context or omitting judgments can reduce tokens further, but weakens the required independent review and can conceal contradictory surrounding evidence. Reversible references and targeted repair preserve those requirements at the cost of an explicit codec, patch validation, and fallback for outputs whose identities cannot be safely recovered. No offline representation comparison establishes equal semantic quality or actual provider billing; live calibration owns those conclusions.

## Links

- [Source review workflow](../../worlds/fanren/authoring/sources/adjudication.md)
- [Adjudication runner](../../scripts/world-authoring/adjudicate-fanren.ts)
- [Semantic contract](../../scripts/world-authoring/source-adjudication.ts)
- [DeepSeek thinking mode and supported effort levels](https://api-docs.deepseek.com/guides/thinking_mode/)
