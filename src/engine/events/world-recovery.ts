import { contentHash } from "../models/model-audit";
import type { ProgramResources } from "../programs/definition";
import type { JsonValue } from "../runtime/json";
import type { WorldAdjudication } from "./adjudication";
import { worldBranchDiagnostic } from "./adjudication";
import { captureReads, type ReadSet } from "./resources";
import type { PendingProgramAttempt } from "./runtime-state";
import { renderWorldText } from "./world-program";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const inputSchema = z.object({ reads: z.record(z.string(), z.object({ version: z.number().int().nonnegative(), hash }).strict()),
  sourceHashes: z.record(z.string(), hash) }).strict();
export const worldRecoverySchema = inputSchema.extend({ disposition: z.enum(["wait", "expand"]),
  revisedInputs: z.array(inputSchema), rejectedProgramHashes: z.array(hash), evidenceHashes: z.array(hash) }).strict();

export interface WorldAttemptRecovery {
  disposition: "wait" | "expand";
  reads: ReadSet;
  sourceHashes: Record<string, string>;
  revisedInputs: Array<{ reads: ReadSet; sourceHashes: Record<string, string> }>;
  rejectedProgramHashes: string[];
  evidenceHashes: string[];
}

export function worldInputUnchanged(input: { reads: ReadSet; sourceHashes: Record<string, string> }, resources: ProgramResources,
  sources: Record<string, JsonValue>) {
  return Object.entries(input.reads).every(([key, read]) => resources[key]?.version === read.version && contentHash(resources[key]?.value ?? null) === read.hash) &&
    Object.entries(input.sourceHashes).every(([id, hash]) => contentHash(sources[id] ?? null) === hash);
}

/** Hash only the complete input actually used by this attempt's last judgment. */
export function worldRecoveryInput(pending: PendingProgramAttempt, resources: ProgramResources, sources: Record<string, JsonValue>) {
  const keys = pending.recovery ? Object.keys(pending.recovery.reads) : pending.bound
    ? pending.bound.program.definition.reads.map(key => renderWorldText(key, pending.bound!.parameters)) : Object.keys(resources);
  const reads = captureReads(resources, keys.filter(key => key !== "rng" && !key.startsWith("random:")));
  const sourceIds = pending.recovery ? Object.keys(pending.recovery.sourceHashes) : pending.bound
    ? Object.keys(pending.bound.program.sourceHashes) : Object.keys(sources);
  const sourceHashes = Object.fromEntries(sourceIds.sort().map(id => [id, contentHash(sources[id] ?? null)]));
  return { reads, sourceHashes, hash: contentHash({ reads, sourceHashes }) };
}

/** Persist an unsupported frontier; one revision per unchanged input prevents creation loops. */
export function deferWorldAttempt(pending: PendingProgramAttempt, resources: ProgramResources, sources: Record<string, JsonValue>,
  reason: string, adjudication: Pick<WorldAdjudication, "records" | "evidence"> | null,
  random?: { disposition: "wait" | "expand"; reads: ReadSet; evidenceHash: string }) {
  const records = adjudication?.records.filter(record => record.attemptHash === contentHash(pending.attempt)) ?? [];
  const prior = pending.recovery;
  const keys = [...new Set([...records.flatMap(record => Object.keys(record.readSet)), ...Object.keys(random?.reads ?? {})])];
  const fallback = worldRecoveryInput(pending.bound ? pending : { ...pending, recovery: null }, resources, sources);
  const wait = random?.disposition === "wait" || records.some(record => record.verdict === "unknown" &&
    pending.bound?.program.definition.predicates.some(predicate => predicate.id === record.conditionId && predicate.unknown === "wait"));
  const rejected = prior?.rejectedProgramHashes ?? [];
  pending.recovery = { disposition: wait || !pending.bound ? "wait" : "expand",
    reads: keys.length ? captureReads(resources, keys.filter(key => key !== "rng" && !key.startsWith("random:"))) : fallback.reads,
    sourceHashes: fallback.sourceHashes, revisedInputs: prior?.revisedInputs ?? [],
    rejectedProgramHashes: [...new Set([...rejected, ...(!wait && pending.bound ? [pending.bound.program.hash] : [])])].sort(),
    evidenceHashes: [...new Set([...records.map(record => record.evidenceHash), ...(random ? [random.evidenceHash] : [])])].sort() };
  pending.dependencyHash = worldRecoveryInput(pending, resources, sources).hash;
  pending.failure = pending.bound && records.length ? `${reason}: ${JSON.stringify(worldBranchDiagnostic(pending.bound, resources, records))}` : reason;
  pending.atSeconds = null;
}
