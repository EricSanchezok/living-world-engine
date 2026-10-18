# Use Flash without thinking for ordinary generation

## Status

Accepted
Class: architecture

## Context and Problem Statement

The user requests Flash everywhere, ordinary generation without thinking, low reasoning only where needed, and reuse of Typesafe for closed adjudication. The merged Fanren package instead binds its closed decisions to DeepSeek. The earlier shared low-reasoning creation profile also enables reasoning for narration and every autonomous expression. Provider defaults are unsafe for this cost policy because omitted thinking settings enable high effort.

## Decision Drivers

- Preserve joint action binding, private knowledge and independent NPC goals.
- Avoid extra classifier calls and retain factual publication checks.
- Make model identity and inference explicit on actual outgoing requests, including experiments.
- Keep literary approvals and historical usage evidence unchanged.

## Considered Options

- Keep low reasoning for all generation and all Fanren decisions.
- Disable reasoning and replace open intent with independent closed choices everywhere.
- Route closed Fanren decisions to Typesafe, disable ordinary creation reasoning, and retain explicit low reasoning for complex tasks.

## Decision Outcome

Choose the third option, superseding [0236](0236-reasoning-for-language-boundaries.md). `creation-deepseek` uses Flash with thinking disabled. `decision-deepseek` and its long-context variant retain low reasoning for coherent player interpretation, full-context fallback and publication comparison. Autonomous joint action interpretation also explicitly retains low reasoning: its creative role permits free language, but the same response owns goal continuation and dependent execution parameters. Important-memory compression and an existing narrative repair after a rejected draft explicitly retain low reasoning on DeepSeek. First narrative drafts and suggestions remain non-thinking. Source adjudication retains explicit low reasoning; extraction and regional drafting use ordinary generation settings. No additional inference request or repair attempt is introduced.

The actual DeepSeek transport rejects any model other than deepseek-flash and any inference setting other than explicit disabled or low. The raw experimental network boundary applies the same check; budgeted official requests are checked before reservation. Historical frozen experiments and model prices remain evidence of their original producers: they cannot be silently relabeled or dispatched under a different model. Fresh captures and a new experimental identity are required for reruns.

Fanren's operational profiles have one build input, `worlds/fanren/runtime-models.json`. After validating literary source approvals, the builder binds the manifest, existing Agents, origins and materialized Agents to that same routing and records it in the build receipt. This changes no story fields or signed literary sources. The runtime executes only the resulting package. Default closed decisions use Typesafe; the existing full-context Flash fallback remains explicit when native admission fails.

## Pros and Cons of the Options

- Shared low reasoning is simple but spends reasoning output on every ordinary generation and bypasses an available native decision service.
- Replacing open intent with independent choice fields would recreate the incoherent intention/argument failure and reduce natural behavior.
- Task-owned inference reduces ordinary generation work without removing semantic checks. Non-thinking expression can still fail; real play, failures and actual usage must be measured. Complex fallback still costs tokens, and this change does not promise a fixed saving percentage.

## Links

- [Approved implementation contract](../specs/0207-relevant-npc-wakes-and-model-cost-policy.md)
- [DeepSeek thinking controls and defaults](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Rejected removal of publication reasoning](0265-disable-reasoning-for-publication-comparison.md)
- [Model gateway](../game-design/model-gateway.md)
