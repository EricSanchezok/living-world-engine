import { z } from "zod";
import type { AgentState, BeliefEvidence, SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { RuntimeEvent } from "../runtime/observability";

const hashes = z.record(z.string(), z.string());
export const agentMemorySchema = z.object({
  version: z.number().int().positive(), agentId: z.string(), sourceHash: z.string(),
  summary: z.string(), evidenceHashes: hashes, claimHashes: hashes,
  protectedEvidenceIds: z.array(z.string()), protectedClaimIds: z.array(z.string()),
  executionId: z.string().nullable(),
}).strict();
export type AgentMemory = z.infer<typeof agentMemorySchema>;
export const memoryRecordSchema = z.object({
  checkpoint: agentMemorySchema.nullable(),
  attempt: z.object({ sourceHash: z.string(), status: z.enum(["generating", "succeeded", "failed"]),
    executionId: z.string().nullable(), error: z.string().nullable() }).strict().nullable(),
}).strict();
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export interface MemoryEpisode {
  evidence: BeliefEvidence;
  worldTimeSeconds: number | null;
  interaction: null | { actor: string; actorLocalId: string | null; operation: string; status: string;
    utterance: string | null; result: string; details: unknown };
}

/** Hash membership, rather than a step cutoff, also retains late arrivals and edited claims. */
export function covered(record: { id: string }, coverage: Record<string, string> | undefined): boolean {
  return coverage?.[record.id] === contentHash(record);
}
export function memoryMatches(agent: AgentState, memory: AgentMemory | null | undefined): memory is AgentMemory {
  return Boolean(memory && memory.agentId === agent.id && Object.entries(memory.evidenceHashes)
    .every(([id, hash]) => agent.belief.evidence[id] && contentHash(agent.belief.evidence[id]) === hash));
}

function episodes(state: Readonly<SimulationState>, agent: AgentState, evidence: BeliefEvidence[]): MemoryEpisode[] {
  const observations = new Map(state.history.flatMap(step => step.observations
    .filter(observation => observation.observerId === agent.id)
    .map(observation => [observation.id, { observation, time: step.temporalBoundary.toElapsedSeconds }] as const)));
  return evidence.map(item => {
    const source = item.sourceId ? observations.get(item.sourceId) : undefined;
    const scene = source?.observation.scene;
    return { evidence: structuredClone(item), worldTimeSeconds: source?.time ?? null, interaction: scene ? {
      actor: scene.actor, actorLocalId: scene.actorLocalId ?? null, operation: scene.actionKind, status: scene.status,
      utterance: scene.speech?.utterance ?? null, result: scene.outcome, details: structuredClone(scene.details),
    } : null };
  });
}

/** The sole model-facing memory projection; original evidence remains the validation authority. */
export function readAgentMemory(state: Readonly<SimulationState>, agent: AgentState, checkpoint?: AgentMemory | null) {
  const memory = memoryMatches(agent, checkpoint) ? checkpoint : null;
  const evidence = Object.values(agent.belief.evidence).sort((a, b) => a.step - b.step || a.id.localeCompare(b.id));
  const protectedIds = new Set(memory?.protectedEvidenceIds ?? []);
  const recent = evidence.filter(item => !covered(item, memory?.evidenceHashes));
  const important = evidence.filter(item => protectedIds.has(item.id) && covered(item, memory?.evidenceHashes));
  return {
    version: memory?.version ?? 0,
    summary: memory?.summary ?? "",
    important: episodes(state, agent, important),
    evidence: recent,
    claims: Object.values(agent.belief.claims).filter(claim => !covered(claim, memory?.claimHashes) || memory?.protectedClaimIds.includes(claim.id))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function memorySource(state: Readonly<SimulationState>, agentId: string, checkpoint?: AgentMemory | null) {
  const agent = state.agents[agentId];
  if (!agent) return null;
  const previous = memoryMatches(agent, checkpoint) ? checkpoint : null;
  const view = readAgentMemory(state, agent, previous);
  // A small recent tail remains verbatim regardless of compression size or model capacity.
  const selected = view.evidence.slice(0, -8);
  if (!selected.length) return null;
  const evidenceHashes = { ...previous?.evidenceHashes, ...Object.fromEntries(selected.map(item => [item.id, contentHash(item)])) };
  const claims = Object.values(agent.belief.claims).filter(claim => !covered(claim, previous?.claimHashes) &&
    claim.evidenceIds.length > 0 && claim.evidenceIds.every(id => evidenceHashes[id]));
  const claimHashes = { ...previous?.claimHashes, ...Object.fromEntries(claims.map(item => [item.id, contentHash(item)])) };
  const mandatory = [...agent.character.persona.evidenceIds, ...Object.entries(agent.character)
    .filter(([key]) => key !== "persona").flatMap(([, records]) => Object.values(records)
      .flatMap(value => (value as { evidenceIds?: string[] }).evidenceIds ?? []))];
  const input = { agentId, previousVersion: previous?.version ?? 0,
    previousSummary: previous?.summary ?? "", protectedMemories: view.important,
    identities: Object.values(agent.belief.localEntities), character: structuredClone(agent.character),
    episodes: episodes(state, agent, selected), claims: structuredClone(claims) };
  return { agentId, previousVersion: previous?.version ?? 0, sourceHash: contentHash(input), input,
    evidenceHashes, claimHashes,
    protectedEvidenceIds: [...new Set([...(previous?.protectedEvidenceIds ?? []), ...mandatory.filter(id => evidenceHashes[id])])],
    protectedClaimIds: [...(previous?.protectedClaimIds ?? [])] };
}
export type MemorySource = NonNullable<ReturnType<typeof memorySource>>;
export const memoryOutputSchema = z.object({
  summary: z.string().trim().min(1),
  retainEvidenceIds: z.array(z.string()), retainClaimIds: z.array(z.string()),
}).strict();

export function finishMemory(source: MemorySource, output: z.infer<typeof memoryOutputSchema>, executionId: string | null): AgentMemory {
  const allowedEvidence = new Set(source.input.episodes.map(item => item.evidence.id));
  const allowedClaims = new Set(source.input.claims.map(item => item.id));
  if (output.retainEvidenceIds.some(id => !allowedEvidence.has(id)) || output.retainClaimIds.some(id => !allowedClaims.has(id))) {
    throw new Error("Memory protection references an unknown source record");
  }
  const checkpoint: AgentMemory = { version: source.previousVersion + 1, agentId: source.agentId, sourceHash: source.sourceHash,
    summary: output.summary, evidenceHashes: source.evidenceHashes, claimHashes: source.claimHashes,
    protectedEvidenceIds: [...new Set([...source.protectedEvidenceIds, ...output.retainEvidenceIds])],
    protectedClaimIds: [...new Set([...source.protectedClaimIds, ...output.retainClaimIds])], executionId };
  // Reduction is measured on the replaced portion, not an arbitrary percentage of the whole request.
  const before = { summary: source.input.previousSummary, episodes: source.input.episodes, claims: source.input.claims };
  const after = { summary: checkpoint.summary,
    episodes: source.input.episodes.filter(item => checkpoint.protectedEvidenceIds.includes(item.evidence.id)),
    claims: source.input.claims.filter(item => checkpoint.protectedClaimIds.includes(item.id)) };
  if (JSON.stringify(after).length >= JSON.stringify(before).length) throw new Error("Memory compaction did not reduce the covered context");
  return checkpoint;
}

export interface MemoryPressure {
  ratio: number; estimatedInputTokens: number; inputLimit: number; estimatedQuestionTokens?: number; questionLimit?: number;
}
export interface AgentMemoryAccess {
  read(agentId: string): AgentMemory | null;
  pressure(agentIds: readonly string[], measurement: MemoryPressure, signal?: AbortSignal, versions?: Record<string, number>): Promise<void>;
}
/** Read versions from the actual frozen request, never from another parallel task's latest read. */
export function requestMemoryVersions(context: unknown): Record<string, number> {
  const versions: Record<string, number> = {};
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const object = value as { agentId?: unknown; memory?: { version?: unknown }; actorMemory?: Record<string, { version?: unknown }> };
    if (typeof object.agentId === "string" && typeof object.memory?.version === "number") versions[object.agentId] = object.memory.version;
    if (object.actorMemory) for (const [id, memory] of Object.entries(object.actorMemory)) if (typeof memory.version === "number") versions[id] = memory.version;
    for (const child of Object.values(value)) visit(child);
  };
  visit(context); return versions;
}
export class MemoryContextChanged extends Error {
  constructor() { super("Agent memory was compacted; rebuild the complete request"); }
}
/** Replay consumes the exact checkpoints read by the original producer, without generation. */
export function recordedMemoryAccess(events: readonly RuntimeEvent[], fallback?: AgentMemoryAccess): AgentMemoryAccess {
  const reads = new Map<string, Array<AgentMemory | null>>();
  for (const event of events) if (event.event === "memory.read" && event.payload) {
    const { agentId, checkpoint } = event.payload as { agentId: string; checkpoint: AgentMemory | null };
    const values = reads.get(agentId) ?? []; values.push(checkpoint); reads.set(agentId, values);
  }
  return { read: id => {
    const queue = reads.get(id);
    return queue?.length ? structuredClone(queue.shift()!) : fallback?.read(id) ?? null;
  }, pressure: fallback?.pressure.bind(fallback) ?? (async () => {}) };
}
/** Every retry requires a newer checkpoint; a bounded loop covers concurrent background completion. */
export async function withFreshMemory<T>(work: () => Promise<T>): Promise<T> {
  for (let rebuilds = 0; ; rebuilds++) {
    try { return await work(); } catch (error) {
      if (!(error instanceof MemoryContextChanged)) throw error;
      if (rebuilds >= 3) throw new Error("Memory changed repeatedly while rebuilding the request; try again at the next decision boundary");
    }
  }
}
