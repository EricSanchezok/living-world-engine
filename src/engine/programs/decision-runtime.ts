import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { decisionPrompt, executeDecision, nativeDecisionBounds, validateDecisionBatch, type DecisionBatch, type DecisionRequest, type DecisionResult } from "../models/decision";
import type { ModelExecutionScope, StructuredModelProvider } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { programHash, type ProgramResources } from "./definition";
import { ProgramInterpreter, type ProgramPredicateWork } from "./interpreter";

export interface DecisionUse { result: DecisionResult; evidenceHash: string; reused: boolean }
const cacheSchema = z.object({ version: z.literal(1), entries: z.array(z.object({ key: programHash, result: z.unknown() }).strict()).max(512), hash: programHash }).strict();

/** Cache reuse refers to the original physical invocation; it never creates another model audit. */
export class DecisionRuntime {
  private readonly cache = new Map<string, DecisionResult>();
  private readonly pending = new Map<string, Promise<DecisionResult>>();
  constructor(readonly provider: StructuredModelProvider, snapshot?: unknown) {
    if (snapshot !== undefined) {
      const { hash, ...value } = cacheSchema.parse(snapshot);
      if (hash !== contentHash(value)) throw new Error("decision cache checksum mismatch");
      for (const entry of value.entries) {
        if (this.cache.has(entry.key)) throw new Error("duplicate decision cache key");
        this.cache.set(entry.key, structuredClone(entry.result) as DecisionResult);
      }
    }
  }
  snapshot() {
    const value = { version: 1 as const, entries: [...this.cache].map(([key, result]) => ({ key, result })) };
    return structuredClone({ ...value, hash: contentHash(value) });
  }
  async decide(request: DecisionRequest): Promise<DecisionUse> {
    const batch = validateDecisionBatch(request.batch);
    if (batch.view.kind === "agent" && batch.view.agentId !== request.subjectId) throw new Error("decision cache cannot cross Agent ownership");
    const key = contentHash({ batch, promptVersion: decisionPrompt().version, catalogHash: this.provider.catalog.hash,
      registry: request.modelRegistrySnapshotHash ?? null, profile: request.profileId, fallback: request.fallbackProfileId ?? null });
    const cached = request.modelRegistrySnapshotHash ? this.cache.get(key) : undefined;
    if (cached) {
      if (cached.inputHash !== contentHash({ batch, promptVersion: decisionPrompt().version }) ||
        cached.audit.registrySnapshotHash !== request.modelRegistrySnapshotHash || cached.audit.modelCatalogHash !== this.provider.catalog.hash) {
        throw new Error("cached decision differs from its authorized input or model identity");
      }
      return { result: structuredClone(cached), evidenceHash: contentHash(cached), reused: true };
    }
    const existing = request.modelRegistrySnapshotHash ? this.pending.get(key) : undefined;
    if (existing) { const result = await existing; return { result: structuredClone(result), evidenceHash: contentHash(result), reused: true }; }
    const call = executeDecision(this.provider, { ...request, batch });
    if (request.modelRegistrySnapshotHash) this.pending.set(key, call);
    try {
      const result = await call;
      if (request.modelRegistrySnapshotHash) {
        if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, structuredClone(result));
      }
      return { result, evidenceHash: contentHash(result), reused: false };
    } finally { this.pending.delete(key); }
  }
}

export interface ProgramDecisionScope extends ModelExecutionScope {
  profileId: string;
  fallbackProfileId?: string;
  /** One engine-owned ordinal per physical request, shared by all rounds for this subject and revision. */
  nextInvocation: () => number;
}

/** One dependency round. The caller repeats only when control flow exposes genuinely new work. */
export async function resolveProgramPredicates(runtime: DecisionRuntime, interpreter: ProgramInterpreter, resources: ProgramResources,
  atSeconds: number, scope: ProgramDecisionScope): Promise<{ decisions: DecisionUse[]; mechanicalEvidence: string[] }> {
  const initial = interpreter.work(resources, atSeconds).filter((work): work is ProgramPredicateWork => work.kind === "predicate");
  const mechanicalEvidence: string[] = [];
  const isCurrent = (work: ProgramPredicateWork) => interpreter.work(resources, atSeconds).some(candidate => candidate.id === work.id);
  for (const work of initial.filter(work => work.mechanicalVerdict !== null)) if (isCurrent(work)) {
    const evidence = contentHash({ evaluator: "program-arithmetic-v1", work, verdict: work.mechanicalVerdict });
    interpreter.resolve(work, resources, work.mechanicalVerdict!, evidence, atSeconds); mechanicalEvidence.push(evidence);
  }
  const work = initial.filter(work => work.mechanicalVerdict === null && isCurrent(work));
  const groups = new Map<string, ProgramPredicateWork[]>();
  for (const item of work) {
    const key = `${item.predicateId}:${item.inputHash}`;
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  const predicates = new Map(interpreter.program.definition.predicates.map(predicate => [predicate.id, predicate]));
  const instruction = loadPromptAsset("shared/program-predicate.md");
  const makeBatch = (selected: ProgramPredicateWork[][]): DecisionBatch => {
    const state = { parameters: interpreter.parameterValues,
      resources: Object.assign({}, ...selected.map(group => group[0]!.state)) as Record<string, { version: number; value: import("../runtime/json").JsonValue }> };
    return { version: 1, view: { kind: "agent", agentId: interpreter.program.definition.owner.agentId, projectionHash: contentHash(state) },
      programHash: interpreter.program.hash, state,
      dependencies: Object.fromEntries(Object.entries(state.resources).map(([key, value]) => [key, value.version])),
      questions: Object.fromEntries(selected.map((group, index) => {
        const predicate = predicates.get(group[0]!.predicateId)!;
        if (predicate.test.kind !== "semantic") throw new Error("mechanical predicate reached the model boundary");
        return [`q${index}`, { version: contentHash(predicate), instructions: `${instruction}\n\n${predicate.test.instructions}\n${JSON.stringify({ relevantResources: predicate.reads })}`,
          criteria: { yes: "The supplied evidence establishes the condition.", no: "The supplied evidence explicitly contradicts the condition.",
            unknown: "There is insufficient evidence to establish or contradict the condition." }, sources: predicate.sourceIds }];
      })),
    };
  };
  // Identical lossless partitioning for the generative comparison arm. A single
  // inseparable oversized question reaches the explicit context fallback.
  const partitions: ProgramPredicateWork[][][] = []; let current: ProgramPredicateWork[][] = [];
  for (const group of groups.values()) {
    const next = [...current, group];
    if (current.length && !nativeDecisionBounds(makeBatch(next)).fits) { partitions.push(current); current = [group]; }
    else current = next;
  }
  if (current.length) partitions.push(current);
  const decisions: DecisionUse[] = [];
  for (const partition of partitions) {
    const use = await runtime.decide({ ...scope, batch: makeBatch(partition), subjectId: interpreter.program.definition.owner.agentId,
      modelInvocation: scope.nextInvocation() });
    decisions.push(use);
    for (const [index, group] of partition.entries()) {
      const verdict = use.result.answers[`q${index}`]!.choice;
      if (!(verdict === "yes" || verdict === "no" || verdict === "unknown")) throw new Error("invalid program predicate answer");
      for (const item of group) if (isCurrent(item)) interpreter.resolve(item, resources, verdict, use.evidenceHash, atSeconds);
    }
  }
  return { decisions, mechanicalEvidence };
}
