# Eager-reference slot batching

Artifact-Version: 1
Status: Implemented

## Intent

Make Action Compilation and AgentMind request cardinality independently tunable so a world instance can trade model latency against multi-slot output reliability without moving batching policy into the fixed engine. The eager-reference algorithm owns slot formation, prompt shape, validation, recovery, and defaults. The fixed engine only pins and replays opaque algorithm configuration.

The default eager-reference configuration uses at most twelve Action Compilation slots, eight AgentMind slots, eight Reaction slots, and sixteen Action Grounding slots per physical request or worker wave. Each limit accepts integers from one through sixty-four and remains immutable for the life of an instance. AgentMind batching covers bootstrap, ordinary mind updates, and policy resume in separate groups; reaction and grounding limits are independently pinned with the algorithm manifest.

This change does not alter world evolution semantics, the canonical committer, Script contracts, model-gateway scheduling, or Observation batching.

## Contract

`AlgorithmRef` carries the JSON-safe configuration used to derive its manifest hash. The algorithm registry treats configuration as opaque, asks the registered algorithm definition to construct the exact manifest and implementation, and rejects a reference whose derived manifest does not match. Instance creation pins one configured reference, and recorded replay reconstructs the algorithm from the recorded producer manifest rather than current defaults.

The developer-facing instance creation request may provide `executionTuning.actionCompilationMaxSlots`, `executionTuning.agentMindMaxSlots`, `executionTuning.reactionMaxSlots`, and `executionTuning.groundingMaxSlots`. Missing values use twelve, eight, eight, and sixteen respectively. Unknown fields, non-integers, and values outside one through sixty-four fail before bootstrap or model work. Ordinary instance responses do not expose the configuration.

Eager-reference groups Action Compilation by model profile and AgentMind by purpose plus model profile. A configured value is a maximum: serialized request size, profile differences, tail cardinality, validation recovery, and recursive splitting may produce smaller batches. A value of one uses the same batch protocol with one slot.

Every physical request contains engine-numbered slots and returns complete, unique slot coverage. Shared Action Compilation catalog and temporal material appear once per request. AgentMind serializes each slot as one self-contained object containing `agentState`, `task`, `referenceCatalog`, `allowedTargetHandles`, and `repair`; canonical and cognition identities remain engine-owned.

Parsed valid slots survive a partial semantic failure; only invalid slots receive repair context and retry. An unassignable structural failure retries the current batch. A batch node receives one initial attempt and two repairs, then splits deterministically. Action Compilation singleton exhaustion fails the step. AgentMind singleton semantic exhaustion uses the existing empty-patch and waiting-action fallback. Transport, configuration, overload, and cancellation failures propagate without semantic splitting.

One physical request contributes one model audit regardless of slot count. The candidate stores each audit once, and runtime telemetry records requested, accepted, retried, split, and fallback slot counts.

Parallel batch owners retain the first failure and wait for every started branch to finish recording evidence before returning it. This applies recursively to fitted batches, repair splits, cognition profiles and cognition purposes. Once a recovery tree has a terminal failure, its remaining branches cannot start additional repair or split calls. Already-started calls may finish and record their actual outcomes; they cannot produce a partial world commit. Private intention guard batches retain the same completion ownership.

## Plan

Add configurable algorithm definitions and configuration-bearing references, then bump the forward-only execution and instance contracts. Implement a private eager-reference slot batching helper and replace the single-action and single-Agent paths while retaining the existing validation and fallback owners. Add request tuning to instance creation and independent slot matrices to deterministic experiments. Update the architecture and runtime observability references after the executable contract is stable.

## Verification

Cover limits one, two, three, twelve, and sixty-four; mixed profiles and AgentMind purposes; byte-boundary partitioning; tail batches; complete slot coverage; partial semantic failures; structural failures; recursive splitting; singleton failure policies; cancellation; and unique audits. Prove that deterministic one-slot and multi-slot executions produce the same canonical semantic result, that configuration changes the manifest hash, and that restart and recorded replay retain the original configuration.

Run `npm run check:fast`, `npm run world:validate -- worlds/blackmarsh/world`, `npm run build`, `node scripts/run-gates.mjs`, and `git diff --check`. Run the credentialed DeepSeek smoke manually to verify the production dialect and repair behavior.

## Evidence

- Configured identity and forward-only persistence: [`execution.ts`](../../src/engine/runtime/execution.ts), [`builtin-algorithms.ts`](../../src/engine/algorithms/registry.ts), [`eager-reference.ts`](../../src/engine/algorithms/eager-reference/eager-reference.ts), [`world-instance-types.ts`](../../src/server/world-instance-types.ts), [`world-instance-store.ts`](../../src/server/world-instance-store.ts), and [`world-host.ts`](../../src/server/world-host.ts).
- Private batching, validation, repair, and audit separation: [`eager-slot-batching.ts`](../../src/engine/algorithms/eager-reference/eager-slot-batching.ts), [`action-compiler.ts`](../../src/engine/algorithms/eager-reference/action-compiler.ts), and [`agent-mind.ts`](../../src/engine/algorithms/eager-reference/agent-mind.ts).
- Boundary and recovery tests: [`eager-slot-batching.test.ts`](../../src/engine/algorithms/eager-reference/__tests__/eager-slot-batching.test.ts), [`eager-reference.test.ts`](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts), [`world-instance-host.test.ts`](../../src/server/__tests__/world-instance-host.test.ts), and [`execution-ledger.test.ts`](../../src/server/__tests__/execution-ledger.test.ts).
- Blackmarsh and experiment coverage: [`blackmarsh-world.test.ts`](../../src/server/__tests__/blackmarsh-world.test.ts), [`execution-experiment.test.ts`](../../src/server/__tests__/execution-experiment.test.ts), [`experiment-core.ts`](../../scripts/experiments/experiment-core.ts), and [`experiment-run.ts`](../../scripts/experiments/experiment-run.ts).
- Verified with `npm run check:fast`, `npm run world:validate -- worlds/blackmarsh/world`, `npm run build`, `node scripts/run-gates.mjs`, and `git diff --check`.
- The requested 48-Agent deterministic `1,4,8,12 × 1,2,4,8` matrix completed all sixteen scenarios successfully. At the default `12/8`, Action Compilation used four physical calls and Agent bootstrap/mind used six calls per phase.
- `npm run test:live:deepseek:batching` completed real Blackmarsh DeepSeek bootstrap and step preparation at the default `12/8`: 48 Agent bootstrap slots used six initial batches plus two repairs; 48 Action Compilation slots used four initial batches plus one localized repair and no split; neither phase reached singleton failure, and invocation IDs remained unique.
