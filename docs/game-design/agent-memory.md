# Agent memory

This reference owns derived long-term context in the shipped Direct runtime. [Spec 0192](../specs/0192-background-agent-memory.md) defines acceptance and [decision 0245](../decisions/0245-incremental-agent-memory.md) records the tradeoff.

## Read model

One reader combines an incremental chronological summary, protected verbatim records and uncovered recent evidence/claims. Current identity, known entities, character state, goals and commitments remain structured inputs. Direct action decisions, expressions and actor evidence in world adjudication use this reader. Original evidence and history remain authoritative for references, trusted inspection and replay; ordinary model calls do not append the archived prefix again.

The compactor selects important new evidence/claim IDs; code retains those original records and carries existing protected IDs forward. Character-referenced evidence is protected deterministically. Protection preserves the historical record, not the continued truth of an old condition: later evidence or current structured status can correct a belief or fulfill a promise. Summaries retain attribution and uncertainty. No summary changes canonical state or Agent cognition.

## Capacity and scheduling

The gateway estimates the complete rendered request, including task instructions and schemas. Native Jev requests measure shared state plus all questions and shared state plus the largest individual question. The pinned model context capacity and Profile `max_question_tokens` define limits; a generative context reserves the Profile's output allowance. `max_input_tokens` optionally lowers capacity for controlled qualification. Byte protection remains independent.

The multilingual estimator is conservative, is labeled as an estimate and uses actual returned input-token usage to increase its per-model calibration when necessary. Aggregate provider usage does not constitute an exact per-question token count. At 80% occupancy the source owner's memory task enters the existing gateway as background-priority work. One service worker runs at a time, with one outstanding task per instance/Agent. Queued foreground requests take priority; active HTTP calls are not interrupted.

The newest eight evidence records remain verbatim. A compaction reads the previous summary, protected records and the eligible frozen prefix, using the Agent's bound creation Profile. There is no fixed resulting occupancy target. A candidate must reduce the replaced representation and reference only supplied record IDs. Failed/no-reduction attempts are not repeated against an identical source. A full request waits for useful work and rebuilds after a new checkpoint, with at most three rebuilds per task; unresolved capacity errors preserve all memory and remain explicit.

## Publication and recovery

`WorldInstanceDocument.agentMemories` stores the current checkpoint and latest attempt. Checkpoints bind the Agent ID, memory version, exact covered record hashes, protected IDs and Ledger execution. Publication compares the prior version and source evidence, then merges with the latest instance through CAS. Coverage matches IDs and hashes, not step ranges: late evidence and changed claims remain uncovered. World-run persistence carries current memory metadata forward; compaction advances neither revision nor world time.

Ordinary instance reads start no tasks. Restart reuses completed checkpoints and marks interrupted work eligible for fresh demand. Each execution records the exact memory reads and capacity rebuilds so recorded replay consumes the same checkpoints and model outputs without inference. Detailed compaction inputs, output, versions and failures use the existing Ledger.

A finite context cannot hold unlimited indispensable records. If protected knowledge or non-memory task content exhausts capacity, the engine reports that condition rather than deleting important records. Compression bounds model history growth; it does not bound raw archive storage or eliminate full-state persistence costs.

## Qualification

Run `npx tsx scripts/operations/memory-playtest.ts <ignored-output-directory>` with configured process credentials. The harness authors a small world, seeds an accumulated private history and pins the production model profiles, submits ordinary participant actions through WorldHost, records actual NPC utterances and checkpoints, and checks both world replay and recorded execution replay. Nine ordinary conversations separate the delivery of new information from the final recall question. Its initial history accelerates repeated compression without lowering production capacities. Evaluate recall against original delivered/source records, including identity, help/harm, quantities, deadlines, codes and later corrections, rather than accepting a model's assertion that it remembers.
