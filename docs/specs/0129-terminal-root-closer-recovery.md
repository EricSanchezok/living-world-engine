# Terminal Root Closer Recovery Experiment

Artifact-Version: 1
Status: Approved

## Intent

Under the autonomous [player-action efficiency experiment](0122-player-action-efficiency.md), evaluate a separately identified local interpretation for exactly one redundant terminal root closer. This boundary is distinct from [internal unmatched-closer recovery](0031-unmatched-closer-recovery-experiment.md), whose root-suffix rejection remains authoritative for that policy. Authorization covers an isolated experiment, not a runtime default or reinterpretation of historical failures.

## Contract

The opt-in `terminal-root-closer-v1` candidate removes exactly one final non-whitespace character, which must be the closing delimiter matching the first non-whitespace root opener. All remaining characters, including whitespace, remain in their original order. The complete surviving text must parse strictly as one JSON object or array and contain no duplicate keys, including escaped spellings. No field, value, reference, separator, opener, internal delimiter or second terminal character may be removed or inserted. There is no partial-root salvage or schema-guided search for an interpretation.

Strict parsing retains precedence. This narrow candidate runs before the existing top-level continuation guard, which continues to reject any suffix the candidate declines. Existing default and `unmatched-closers-v1` behavior remain unchanged. Complete correction and legacy broad-repair branches retain their separately identified behavior; this candidate's guarantees do not describe those branches. Native structured-output modes cannot select the policy. The selection changes no physical model request, source context, example, schema, model, thinking setting or retry ceiling.

Preserve the original response and record the policy, original-response hash, recovered-text hash and one deletion offset in original UTF-16 code units, including any leading BOM or whitespace. Recovery declares a deterministic syntax interpretation, not the author's intended semantics. The recovered value passes the same canonical schema, reference permissions, complete target coverage, materializer and semantic checks. A semantic rejection retains its syntax evidence and follows ordinary bounded repair rules. Local recovery is not a model repair or a new sample, and replayed usage is not newly charged usage.

## Plan

Implement the isolated candidate and explicit gateway selection. Replay immutable complete responses through the actual gateway and SimulationEngine onset-to-AgentMind path with network access replaced by saved HTTP responses. Preserve first physical request identity and all original source inputs. Compare against the unchanged parser, reject unrecorded requests before dispatch, and retain historical results independently. Source fidelity and full-world qualification remain separate requirements.

## Verification

Cover object and array roots, nested containers, delimiters inside escaped strings, Unicode offsets and whitespace. Reject duplicate keys at any depth, multiple or mixed trailing closers, dangling fields, concatenated roots, scalar roots, missing structure and malformed interiors. Verify unchanged strict/default/old-policy behavior, physical request equality, recovery evidence on both acceptance and schema rejection, unsupported transport rejection, actual materialization and semantic reference rejection. Run focused checks and `npm run check:fast` before the local commit. Frozen replay evidence must distinguish parse acceptance, source-semantic review and actual gameplay completion.

## Evidence

[Decision 0182](../decisions/0182-isolate-terminal-root-closer-recovery.md) owns the alternative rationale. Immutable experiment manifests and raw responses own observations. The encompassing player-action experiment owns source review, prospective qualification and complete 49-Agent gameplay acceptance.
