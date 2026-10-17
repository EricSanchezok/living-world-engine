import { agentCapabilityModels } from "../engine/models/capability-bindings";
import { contentHash } from "../engine/models/model-audit";
import { ContextLimitExceededError, type ModelExecutionScope, type StructuredModelProvider } from "../engine/models/model-provider";
import { loadPromptAsset } from "../engine/prompts";
import { defineEngineOperationManifest } from "../engine/runtime/execution";
import { runtimeEventEmitter } from "../engine/runtime/observability";
import type { RuntimeObserver } from "../engine/runtime/observability";
import { finishMemory, memoryMatches, memoryOutputSchema, memorySource, MemoryContextChanged,
  type AgentMemoryAccess, type MemorySource, type AgentMemory } from "../engine/cognition/memory";
import type { DirectRuntimeState } from "../engine/direct/contracts";
import type { WorldInstanceDocument } from "./world-instance-types";
import { estimateTokens } from "../engine/models/context-budget";

const system = loadPromptAsset("system/agent-memory.md"), userPrompt = loadPromptAsset("user/agent-memory.md");
export const MEMORY_MANIFEST = defineEngineOperationManifest({ id: "agent-memory", version: "2",
  config: { promptVersion: contentHash({ system, userPrompt }), triggerRatio: 0.8, recentEvidenceCount: 8,
    minimumNewTokens: 2048, amortizePreviousMemory: true } });
interface MemoryHost {
  read(id: string): WorldInstanceDocument;
  update(id: string, change: (document: WorldInstanceDocument) => boolean, finish?: { id: string; semanticHash: string }): Promise<boolean>;
  begin(document: WorldInstanceDocument, signal: AbortSignal): { id: string | null; scope: ModelExecutionScope };
  fail(id: string | null, error: unknown): void;
}

/** Checkpoints are instance metadata, never semantic world commits. */
export class AgentMemoryService {
  private workers = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly provider: StructuredModelProvider, private readonly host: MemoryHost) {}
  scope(source: WorldInstanceDocument, observer?: RuntimeObserver): AgentMemoryAccess {
    const current = (id: string): AgentMemory | null => {
      const checkpoint = this.host.read(source.id).agentMemories[id]?.checkpoint;
      return source.state.agents[id] && memoryMatches(source.state.agents[id]!, checkpoint) ? checkpoint : null;
    };
    return {
      read: id => { const checkpoint = current(id);
        runtimeEventEmitter(observer)?.({ event: "memory.read", payload: { agentId: id, checkpoint } });
        return checkpoint; },
      pressure: async (agentIds, measurement, signal, versions = {}) => {
        if (measurement.ratio < 0.8) return;
        signal?.throwIfAborted();
        const owners = [...new Set(agentIds)].filter(id => source.state.agents[id]);
        const jobs: Promise<void>[] = [];
        for (const id of owners) {
          const checkpoint = current(id);
          if (measurement.ratio >= 1 && checkpoint && checkpoint.version > (versions[id] ?? 0)) throw new MemoryContextChanged();
          const prefix = memorySource(source.state, id, checkpoint);
          if (!prefix) continue;
          const newTokens = estimateTokens({
            episodes: prefix.input.episodes.filter(item => !prefix.protectedEvidenceIds.includes(item.evidence.id)),
            claims: prefix.input.claims.filter(item => !prefix.protectedClaimIds.includes(item.id)),
          });
          const minimumNewTokens = Math.max(2048, estimateTokens({ summary: prefix.input.previousSummary,
            important: prefix.input.protectedMemories }));
          if (measurement.ratio < 1 && newTokens < minimumNewTokens) {
            runtimeEventEmitter(observer)?.({ event: "memory.compaction.deferred", attributes: { agentId: id, reason: "insufficient-new-history" },
              measurements: { newTokens, minimumNewTokens, contextOccupancy: measurement.ratio } });
            continue;
          }
          const record = this.host.read(source.id).agentMemories[id];
          if (record?.attempt?.sourceHash === prefix.sourceHash && record.attempt.status === "failed") continue;
          jobs.push(this.start(source, prefix));
        }
        if (measurement.ratio < 1) return;
        if (jobs.length) await abortable(Promise.all(jobs), signal);
        signal?.throwIfAborted();
        if (owners.some(id => (current(id)?.version ?? 0) > (versions[id] ?? 0))) throw new MemoryContextChanged();
        throw new ContextLimitExceededError("The complete request exceeds its context budget and memory compaction cannot currently make room; all original memory is preserved");
      },
    };
  }
  private start(document: WorldInstanceDocument, source: MemorySource): Promise<void> {
    const key = `${document.id}:${source.agentId}`, existing = this.workers.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.queue.catch(() => undefined).then(() => this.compact(document, source, controller.signal));
    this.workers.set(key, { promise, controller }); this.queue = promise;
    void promise.finally(() => { if (this.workers.get(key)?.promise === promise) this.workers.delete(key); }).catch(() => undefined);
    return promise;
  }
  private async compact(document: WorldInstanceDocument, source: MemorySource, signal: AbortSignal): Promise<void> {
    let execution: ReturnType<MemoryHost["begin"]> | undefined;
    try {
      signal.throwIfAborted();
      const admitted = await this.host.update(document.id, latest => {
        if ((latest.agentMemories[source.agentId]?.checkpoint?.version ?? 0) !== source.previousVersion) return false;
        execution = this.host.begin(document, signal);
        const record = latest.agentMemories[source.agentId] ??= { checkpoint: null, attempt: null };
        record.attempt = { sourceHash: source.sourceHash, status: "generating", executionId: execution.id, error: null };
        return true;
      });
      if (!admitted || !execution) return;
      const control = document.state.executionState?.data as unknown as DirectRuntimeState;
      const profiles = agentCapabilityModels(document.state, control, source.agentId);
      const result = await this.provider.generateStructured({ ...execution.scope, priority: "background", abortSignal: signal,
        modelRegistrySnapshotHash: control.registryHash, profileId: profiles.creation, role: "creation", subjectId: source.agentId,
        schemaName: "AgentMemoryV1", promptVersion: `agent-memory-${contentHash({ system, userPrompt })}`,
        system, userPrompt, context: source.input, schema: memoryOutputSchema, jsonExamplePolicy: "omit" });
      signal.throwIfAborted();
      const checkpoint = finishMemory(source, result.value, execution.id);
      runtimeEventEmitter(execution.scope.observer)?.({ event: "memory.compacted", attributes: { agentId: source.agentId },
        payload: { source, checkpoint }, counts: { version: checkpoint.version, protectedRecords: checkpoint.protectedEvidenceIds.length } });
      const published = await this.host.update(document.id, latest => {
        const record = latest.agentMemories[source.agentId];
        if (!record || record.attempt?.sourceHash !== source.sourceHash ||
          (record.checkpoint?.version ?? 0) !== source.previousVersion || !memoryMatches(latest.state.agents[source.agentId]!, checkpoint)) return false;
        record.checkpoint = checkpoint; record.attempt.status = "succeeded"; return true;
      }, execution.id ? { id: execution.id, semanticHash: contentHash(checkpoint) } : undefined);
      if (!published) throw new Error("Memory source or version changed before publication");
    } catch (error) {
      this.host.fail(execution?.id ?? null, error);
      try { await this.host.update(document.id, latest => {
        const record = latest.agentMemories[source.agentId];
        if (record?.attempt?.sourceHash !== source.sourceHash || record.attempt.status !== "generating") return false;
        record.attempt.status = "failed"; record.attempt.error = error instanceof Error ? error.message : String(error); return true;
      }); } catch { /* Deleted instances have no writable checkpoint. */ }
    }
  }
  cancel(id: string) { for (const [key, worker] of this.workers) if (key.startsWith(`${id}:`)) worker.controller.abort(); }
  async drain(id: string): Promise<void> {
    await Promise.all([...this.workers].filter(([key]) => key.startsWith(`${id}:`)).map(([, worker]) => worker.promise));
  }
}
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Memory wait cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
