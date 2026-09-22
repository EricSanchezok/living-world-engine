import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Offline P0 evidence only. This module has no provider, environment, or world-write dependency.
// Protocol and evidence: ../../docs/research/2026-09-22-step-e3-p0.md
export interface ActionInput {
  id: string;
  actorId: string;
  rawText: string;
  targetIds: string[];
  goal?: string;
  means?: string | null;
}

export function actionsDiffer(a: ActionInput, b: ActionInput): boolean {
  return a.id !== b.id || a.rawText !== b.rawText || a.goal !== b.goal || a.means !== b.means ||
    JSON.stringify(a.targetIds) !== JSON.stringify(b.targetIds);
}

interface WorkItem { slot?: number; action: { actorRef: string; rawText: string } }
interface AssignedState { actionSet?: { assigned?: Array<{ actorRef: string; rawText: string }> } }
interface LedgerEvent {
  sequence: number;
  event: string;
  timestamp: string;
  durationMs?: number;
  hashes?: Record<string, string>;
  attributes?: Record<string, unknown>;
  correlation: {
    executionId: string;
    modelInvocationId?: string;
    logicalInvocationId?: string;
    modelRole?: string;
    modelSubject?: string;
    semanticRepairAttempt?: number;
  };
  payload?: {
    actions?: ActionInput[];
    schemaName?: string;
    sourceInvocationId?: string;
    request?: { externalActions: Array<{ agentId: string }> };
    state?: { agents: Record<string, unknown>; truth: { entities: Record<string, unknown> } };
    invocations?: Array<{ id: string; tokenUsage: Record<string, number | null> }>;
    context?: { state?: AssignedState & {
      shared?: { state?: AssignedState };
      slots?: Array<{ slot: number; delta: { state?: AssignedState } }>;
    }; task?: {
      planningWorklist?: { actions: WorkItem[] };
      transitionWorklist?: { actions: WorkItem[] };
    } };
  };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function actionTexts(action: ActionInput): Array<{ pointer: string; text: string; targetIds: string[] }> {
  if (action.rawText.startsWith("CURRENT_PARALLEL_ATTEMPTS_V1 ")) {
    const wrapper = JSON.parse(action.rawText.slice(action.rawText.indexOf("\n") + 1)) as {
      attempts: Array<{ text: string; targetIndices: number[] }>;
    };
    if (!wrapper.attempts?.length || wrapper.attempts.some((x) =>
      typeof x.text !== "string" || !x.text.length || x.targetIndices.some((i) =>
        !Number.isInteger(i) || i < 0 || i >= action.targetIds.length))) {
      throw new Error(`Invalid parallel source: ${action.actorId}`);
    }
    return wrapper.attempts.map((x, i) => ({ pointer: `/attempts/${i}/text`, text: x.text,
      targetIds: x.targetIndices.map((index) => action.targetIds[index]) }));
  }
  return [{ pointer: "/rawText", text: action.rawText, targetIds: action.targetIds }];
}

export interface ClauseAnnotation {
  text: string;
  coverage: "complete" | "partial" | "fallback" | "unknown";
  work: string;
  prerequisites: string;
  residual: string;
  expected: string;
  deterministicOperations: string[];
}
export interface TextAnnotation {
  actorId: string;
  phase: "initial" | "reaction";
  pointer: string;
  textHash: string;
  clauses: ClauseAnnotation[];
}

/** Exact text partitions detect dropped negation, missing parallel members, and stale annotations. */
export function auditCoverage(initial: ActionInput[], final: ActionInput[], annotations: TextAnnotation[]) {
  const initialByActor = new Map(initial.map((a) => [a.actorId, a]));
  if (initialByActor.size !== initial.length || new Set(final.map((a) => a.actorId)).size !== final.length ||
    final.length !== initial.length || final.some((a) => !initialByActor.has(a.actorId))) {
    throw new Error("Action roster must be complete and unique across phases");
  }
  const changed = final.filter((a) => actionsDiffer(a, initialByActor.get(a.actorId)!));
  const expected = [
    ...initial.map((action) => ({ action, phase: "initial" as const })),
    ...changed.map((action) => ({ action, phase: "reaction" as const })),
  ].flatMap(({ action, phase }) => actionTexts(action).map((part) => ({ ...part, action, phase })));
  const key = (x: { actorId: string; phase: string; pointer: string }) => `${x.phase}:${x.actorId}:${x.pointer}`;
  const index = new Map(annotations.map((a) => [key(a), a]));
  if (index.size !== annotations.length || index.size !== expected.length) throw new Error("Annotation membership mismatch");
  return expected.map(({ action, phase, pointer, text, targetIds }) => {
    const annotation = index.get(key({ actorId: action.actorId, phase, pointer }));
    if (!annotation || annotation.textHash !== sha256(text) || !annotation.clauses.length ||
      annotation.clauses.map((c) => c.text).join("") !== text) {
      throw new Error(`Incomplete or stale clause partition: ${phase}:${action.actorId}:${pointer}`);
    }
    let offset = 0;
    const clauses = annotation.clauses.map((clause) => {
      if (!clause.text || !clause.work || !clause.prerequisites || !clause.expected ||
        !["complete", "partial", "fallback", "unknown"].includes(clause.coverage) ||
        (clause.coverage !== "complete" && !clause.residual) || !Array.isArray(clause.deterministicOperations) ||
        ((clause.coverage === "complete" || clause.coverage === "partial") && !clause.deterministicOperations.length)) {
        throw new Error("Incomplete clause assessment");
      }
      const start = offset;
      offset += clause.text.length;
      return { ...clause, startUtf16: start, endUtf16: offset };
    });
    return { actorId: action.actorId, actionId: action.id, phase, pointer, targetIds,
      currentBoundary: phase === "initial" ? "initial submitted frontier" : "reaction replacement frontier",
      textHash: annotation.textHash, clauses };
  });
}

export interface DagNode {
  id: string;
  durationMs: number;
  parents: string[];
  actorIds: string[];
  replaceable: boolean;
}

/** Whole physical requests are removable; partial batch coverage never scales measured latency. */
export function criticalPath(nodes: DagNode[], fullyCoveredActors: Set<string>) {
  const index = new Map(nodes.map((n) => [n.id, n]));
  if (index.size !== nodes.length) throw new Error("Duplicate DAG node");
  const active = new Set<string>();
  const resolved = new Map<string, { ms: number; path: string[] }>();
  const removed: string[] = [];
  function visit(id: string): { ms: number; path: string[] } {
    if (resolved.has(id)) return resolved.get(id)!;
    const n = index.get(id);
    if (!n || active.has(id) || !Number.isFinite(n.durationMs) || n.durationMs < 0) throw new Error(`Invalid DAG at ${id}`);
    active.add(id);
    const parent = n.parents.map(visit).reduce<{ ms: number; path: string[] } | undefined>(
      (a, b) => !a || b.ms > a.ms ? b : a, undefined,
    ) ?? { ms: 0, path: [] };
    const eliminate = n.replaceable && n.actorIds.length > 0 && n.actorIds.every((a) => fullyCoveredActors.has(a));
    if (eliminate) removed.push(id);
    const result = { ms: parent.ms + (eliminate ? 0 : n.durationMs), path: [...parent.path, id] };
    active.delete(id);
    resolved.set(id, result);
    return result;
  }
  const longest = nodes.map((n) => visit(n.id)).reduce((a, b) => a.ms >= b.ms ? a : b, { ms: 0, path: [] });
  return { ...longest, removed };
}

function readJson<T>(file: string): T { return JSON.parse(readFileSync(file, "utf8")) as T; }

export function extractSource(root: string, directory: string, label: string) {
  const source = path.join(root, directory);
  const files = ["manifest.json", "run/ledger-events.json", "run/result.json", "run/executions.json"];
  const hashes = Object.fromEntries(files.map((file) => [file, sha256(readFileSync(path.join(source, file)))]));
  const manifest = readJson<{ codeRevision: string; algorithm: { id: string; version: string; manifestHash: string }; worldHash: string }>(path.join(source, "manifest.json"));
  const events = readJson<LedgerEvent[]>(path.join(source, "run/ledger-events.json"));
  const preparation = events.find((e) => e.event === "step.preparation.started");
  if (!preparation?.payload?.state || preparation.payload.request?.externalActions.length !== 1) throw new Error("Missing real player entry");
  const executionId = preparation.correlation.executionId;
  const playerEvents = events.filter((e) => e.correlation.executionId === executionId);
  const actions = new Map<string, ActionInput>();
  const captures = playerEvents.filter((e) => e.event === "model.action_compilation.context.captured");
  for (const e of captures) for (const a of e.payload?.actions ?? []) if (!actions.has(a.actorId)) actions.set(a.actorId, a);
  const serialized = new Map(playerEvents.filter((e) => e.event === "model.context.serialized")
    .map((e) => [e.correlation.modelInvocationId, e]));
  const starts = playerEvents.filter((e) => e.event === "model.invocation.started");
  const http = starts.map((e, i) => {
    const invocationId = e.correlation.modelInvocationId!;
    const associated = playerEvents.filter((x) => x.correlation.modelInvocationId === invocationId);
    const transport = associated.find((x) => x.event === "model.transport.completed");
    const audit = associated.find((x) => x.event === "model.audit.persisted")?.payload?.invocations?.find((x) => x.id === invocationId);
    const request = serialized.get(invocationId);
    const ctx = request?.payload?.context;
    const assigned = ctx?.state?.slots?.flatMap((slot) =>
      (slot.delta.state?.actionSet?.assigned ?? ctx.state?.shared?.state?.actionSet?.assigned ?? [])
        .map((action) => ({ slot: slot.slot, action }))) ?? ctx?.state?.actionSet?.assigned?.map((action) => ({ slot: 0, action }));
    const work = ctx?.task?.planningWorklist?.actions ?? ctx?.task?.transitionWorklist?.actions ?? assigned;
    const captured = captures.find((x) => x.payload?.sourceInvocationId === invocationId)?.payload?.actions;
    return {
      id: `p${i + 1}`, invocationId, publicInvocationId: `${executionId}::${invocationId}`,
      startSequence: e.sequence, endSequence: associated.at(-1)!.sequence,
      startedAt: e.timestamp, transportFinishedAt: transport?.timestamp ?? null,
      durationMs: transport?.durationMs ?? null, role: e.correlation.modelRole,
      repairAttempt: e.correlation.semanticRepairAttempt ?? 0,
      schemaName: e.attributes?.schemaName, requestHash: e.hashes?.request,
      contextHash: request?.hashes?.request ?? request?.hashes?.context ?? null,
      tokenUsage: audit?.tokenUsage ?? null,
      rejected: associated.some((x) => x.event === "model.semantic.rejected"),
      actorIds: work?.map((x) => x.action.actorRef.replace(/^ref:agent:/, "")) ?? captured?.map((x) => x.actorId) ?? [],
      components: work ? Object.entries(Object.groupBy(work, (x) => String(x.slot ?? 0)))
        .map(([slot, members]) => ({ slot: Number(slot), actorIds: members!.map((x) => x.action.actorRef.replace(/^ref:agent:/, "")) })) : [],
    };
  });
  if (http.length !== playerEvents.filter((e) => e.event === "model.transport.started").length || http.some((h) => h.durationMs === null)) {
    throw new Error("Transport pairing incomplete; do not silently omit retries or failures");
  }
  const result = readJson<{ status: string; newHttp: number; player: Record<string, unknown>; elapsedMs: number }>(path.join(source, "run/result.json"));
  const executions = readJson<Array<{ id: string; startedAt: string; finishedAt: string; status: string; manifest: { id: string; version: string } }>>(path.join(source, "run/executions.json"));
  return {
    label, directory, hashes, codeRevision: manifest.codeRevision,
    algorithm: { id: manifest.algorithm.id, version: manifest.algorithm.version, manifestHash: manifest.algorithm.manifestHash },
    worldHash: manifest.worldHash, executionId,
    firstSequence: playerEvents[0].sequence, lastSequence: playerEvents.at(-1)!.sequence,
    externalActorId: preparation.payload.request.externalActions[0].agentId,
    agentCount: Object.keys(preparation.payload.state.agents).length,
    entityCount: Object.keys(preparation.payload.state.truth.entities).length,
    capturedActions: [...actions.values()].sort((a, b) => a.actorId.localeCompare(b.actorId)),
    historicalExecutions: executions.map((e) => ({ id: e.id, algorithm: `${e.manifest.id}@${e.manifest.version}`,
      startedAt: e.startedAt, finishedAt: e.finishedAt, status: e.status,
      elapsedMs: Date.parse(e.finishedAt) - Date.parse(e.startedAt) })),
    http, historicalTotalHttp: result.newHttp, historicalPlayer: result.player,
    historicalTotalElapsedMs: result.elapsedMs, historicalStatus: result.status,
  };
}

function main() {
  const [root, output] = process.argv.slice(2);
  if (!root || !output) throw new Error("usage: step-executable-interaction-audit.ts STEP-E2-ROOT NEW-OUTPUT-DIRECTORY");
  const sources = [
    extractSource(root, "recursive-player-02", "/34"),
    extractSource(root, "incremental-player-02", "/51"),
    extractSource(root, "incremental-player-04", "/53"),
  ];
  const evidenceFile = path.join(root, "incremental-player-02/run/step-1-evidence.json");
  const evidenceHash = sha256(readFileSync(evidenceFile));
  if (evidenceHash !== "207eed35e0cba767c07b4b47ac831d97b7ab785ec5c392f7da637b28fef85594") throw new Error("P0 /51 source hash mismatch");
  const evidence = readJson<{
    source: { agents: Record<string, {
      bindings: Record<string, { canonicalEntityIds: string[] }>;
      belief: { localEntities: Record<string, unknown> };
    }> };
    committed: Record<string, unknown> & { initialActions: ActionInput[]; actions: ActionInput[] };
  }>(evidenceFile);
  const { committed } = evidence;
  const report = {
    version: 1, paidModelHttp: 0, sourceEvidenceHash: evidenceHash, sources,
    initialActions: committed.initialActions, finalActions: committed.actions,
    initialTargetBindings: committed.initialActions.flatMap((a) => a.targetIds.map((localId) => ({
      actorId: a.actorId, localId,
      canonicalEntityIds: evidence.source.agents[a.actorId].bindings[localId]?.canonicalEntityIds ?? [],
      knownLocalEntity: Object.hasOwn(evidence.source.agents[a.actorId].belief.localEntities, localId),
    }))),
    historicalCommit: Object.fromEntries(["baseRevision", "revision", "temporalBoundary", "temporalPlans", "outcomes", "events", "operations", "observations", "activityDispositions"].map((k) => [k, committed[k]])),
  };
  mkdirSync(output, { recursive: true });
  const file = path.join(output, "source-inventory.json");
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ file, sha256: sha256(readFileSync(file)), sources: sources.map((s) => ({ label: s.label, actors: s.capturedActions.length, http: s.http.length })) }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
