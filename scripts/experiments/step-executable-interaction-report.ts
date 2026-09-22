import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionTexts, auditCoverage, criticalPath, sha256, type ActionInput, type DagNode, type TextAnnotation, type extractSource } from "./step-executable-interaction-audit";

interface Inventory {
  sourceEvidenceHash: string;
  sources: Array<ReturnType<typeof extractSource>>;
  initialActions: ActionInput[];
  finalActions: ActionInput[];
  initialTargetBindings: Array<{ actorId: string; localId: string; canonicalEntityIds: string[]; knownLocalEntity: boolean }>;
  historicalCommit: {
    baseRevision: number;
    revision: number;
    events: unknown[];
    operations: Array<{ kind: string }>;
    observations: Array<{ observerId: string; text: string }>;
    outcomes: Array<{ proposalId: string; status: string; summary: string }>;
    temporalBoundary: { deltaSeconds: number; dueActivityIds: string[] };
    temporalPlans: Array<{ actorId: string; profileId: string; checkpointSeconds: number }>;
  };
}
interface Annotations { sourceEvidenceHash: string; annotations: TextAnnotation[] }
interface Dag { sourceEvidenceHash: string; inventorySha256: string; executionId: string; parents: Record<string, string[]>; dependencyEvidence: Record<string, string> }

function counts(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {});
}

export function makeReport(source: Inventory, annotations: Annotations, dag: Dag) {
  if (source.sourceEvidenceHash !== annotations.sourceEvidenceHash || source.sourceEvidenceHash !== dag.sourceEvidenceHash) {
    throw new Error("Source, annotations, and DAG must bind the same evidence");
  }
  const primary = source.sources.find((s) => s.label === "/51");
  if (!primary || primary.executionId !== dag.executionId || primary.agentCount !== 49 ||
    source.initialActions.length !== 49 || source.sources.some((s) => s.capturedActions.length !== 49)) {
    throw new Error("P0 requires all three complete 49-subject sources");
  }
  for (const a of source.initialActions) {
    const captured = primary.capturedActions.find((c) => c.actorId === a.actorId);
    if (!captured || captured.rawText !== a.rawText || captured.id !== a.id) throw new Error("Initial actions differ from pre-reaction captures");
  }
  const ledger = auditCoverage(source.initialActions, source.finalActions, annotations.annotations);
  const actorRows = source.initialActions.map((action) => {
    const members = ledger.filter((r) => r.actorId === action.actorId);
    const reaction = members.filter((r) => r.phase === "reaction");
    const effective = reaction.length ? reaction : members;
    const clauses = effective.flatMap((r) => r.clauses);
    const labels = clauses.map((c) => c.coverage);
    const coverage = labels.every((c) => c === "complete") ? "complete" :
      labels.some((c) => c === "complete" || c === "partial") ? "partial" :
        labels.some((c) => c === "unknown") ? "unknown" : "fallback";
    const final = source.finalActions.find((a) => a.actorId === action.actorId)!;
    const outcome = source.historicalCommit.outcomes.find((o) => o.proposalId === final.id);
    const temporal = source.historicalCommit.temporalPlans.find((p) => p.actorId === action.actorId);
    if (!outcome || !temporal) throw new Error("Missing historical outcome or temporal plan");
    return {
      actorId: action.actorId, externalPlayer: action.actorId === primary.externalActorId,
      initialTextCount: members.filter((r) => r.phase === "initial").length,
      initialClauseCount: members.filter((r) => r.phase === "initial").flatMap((r) => r.clauses).length,
      reactionChanged: reaction.length > 0, coverage,
      targetIds: final.targetIds, historicalProfile: temporal.profileId,
      historicalCheckpointSeconds: temporal.checkpointSeconds,
      historicalOutcome: outcome.status,
      expected: clauses[0].expected,
      prerequisites: clauses[0].prerequisites,
    };
  });
  const covered = new Set(actorRows.filter((a) => a.coverage === "complete").map((a) => a.actorId));
  if (Object.keys(dag.parents).length !== primary.http.length || primary.http.some((h) => !Object.hasOwn(dag.parents, h.id))) {
    throw new Error("Every physical request must appear in the DAG exactly once");
  }
  const byId = new Map(primary.http.map((h) => [h.id, h]));
  for (const h of primary.http) for (const parentId of dag.parents[h.id]) {
    const parent = byId.get(parentId);
    if (!parent?.transportFinishedAt || Date.parse(parent.transportFinishedAt) > Date.parse(h.startedAt)) {
      throw new Error(`Dependency contradicts recorded transport order: ${parentId} -> ${h.id}`);
    }
  }
  const nodes: DagNode[] = primary.http.map((h) => ({
    id: h.id, durationMs: h.durationMs!, parents: dag.parents[h.id], actorIds: h.actorIds,
    replaceable: h.role !== "agent-mind" && h.role !== "agent-reaction",
  }));
  const normal = criticalPath(nodes, new Set());
  const removable = criticalPath(nodes, covered);
  const freeCompilation = nodes.map((n) => ({ ...n, durationMs: byId.get(n.id)!.role === "action-compilation" ? 0 : n.durationMs }));
  const freeAllRepair = freeCompilation.map((n) => ({ ...n, durationMs: byId.get(n.id)!.repairAttempt > 0 ? 0 : n.durationMs }));
  const freeEverythingExceptResidualPlanning = nodes.map((n) => ({ ...n,
    durationMs: byId.get(n.id)!.schemaName === "truth_resolution_plan_commit_batch" ? n.durationMs : 0,
  }));
  const plans = primary.http.filter((h) => h.schemaName === "truth_resolution_plan_commit_batch");
  const fallbackComponents = plans.flatMap((h) => h.components).filter((c) => c.actorIds.some((a) => !covered.has(a)));
  const playerAction = source.finalActions.find((a) => a.actorId === primary.externalActorId)!;
  const playerOutcome = source.historicalCommit.outcomes.find((o) => o.proposalId === playerAction.id)!;
  const historicalEmptySuccess = playerOutcome.status === "succeeded" && source.historicalCommit.events.length === 0 &&
    source.historicalCommit.operations.every((o) => o.kind === "advance_time");
  if (!historicalEmptySuccess) throw new Error("Frozen lodging counterexample drifted; source review is required");
  const sourceSummary = source.sources.map((s) => ({
    label: s.label, directory: s.directory, hashes: s.hashes, codeRevision: s.codeRevision,
    algorithm: s.algorithm, executionId: s.executionId, worldHash: s.worldHash,
    historicalExecutions: s.historicalExecutions,
    ledgerSequences: [s.firstSequence, s.lastSequence], agents: s.agentCount, entities: s.entityCount,
    historicalTotalHttp: s.historicalTotalHttp, historicalPlayerHttp: s.http.length,
    historicalPlayerEndMs: s.historicalPlayer.endedElapsedMs,
    historicalFeedbackCount: (s.historicalPlayer.feedback as unknown[]).length,
    historicalRepairHttp: s.http.filter((h) => h.repairAttempt > 0).length,
    historicalFirstRejectedRequests: s.http.filter((h) => h.repairAttempt === 0 && h.rejected).length,
    historicalRepairRejectedRequests: s.http.filter((h) => h.repairAttempt > 0 && h.rejected).length,
    historicalTokenUsage: Object.fromEntries(["input", "output", "cacheRead"].map((k) => [k,
      s.http.some((h) => h.tokenUsage?.[k] == null) ? null : s.http.reduce((n, h) => n + h.tokenUsage![k]!, 0),
    ])),
    capturedInitialTextSha256: sha256(JSON.stringify(s.capturedActions)),
  }));
  return {
    version: 1, protocol: "STEP-E3-P0-W0-v1", sourceEvidenceHash: source.sourceEvidenceHash,
    decision: removable.ms >= 60_000 ? "stop-at-P0" : "requires-oracle-execution-before-P1",
    paidModelHttp: 0, paidModelCostCny: 0,
    scope: "Manual, conservative execution coverage on frozen W0 sources; not a learned classifier, runtime implementation, or population success-rate estimate.",
    sourceSummary,
    workload: {
      actors: actorRows.length,
      initialParallelWrappers: source.initialActions.filter((a) => actionTexts(a).length > 1).length,
      finalParallelWrappers: source.finalActions.filter((a) => actionTexts(a).length > 1).length,
      initialTexts: source.initialActions.flatMap(actionTexts).length,
      finalTexts: source.finalActions.flatMap(actionTexts).length,
      initialClauses: ledger.filter((r) => r.phase === "initial").flatMap((r) => r.clauses).length,
      reactionChangedActors: actorRows.filter((a) => a.reactionChanged).map((a) => a.actorId),
      reactionClauses: ledger.filter((r) => r.phase === "reaction").flatMap((r) => r.clauses).length,
      coverage: { complete: 0, partial: 0, fallback: 0, unknown: 0, ...counts(actorRows.map((a) => a.coverage)) },
      semanticUnitsByWork: counts(ledger.flatMap((r) => r.clauses.map((c) => c.work))),
      fallbackComponentSizes: fallbackComponents.map((c) => c.actorIds.length).sort((a, b) => b - a),
      nonUniqueInitialTargetBindings: source.initialTargetBindings.filter((b) => b.canonicalEntityIds.length !== 1),
    },
    latency: {
      basis: "Whole measured transport durations on the historical request DAG; all local overhead is zero. No proportional token discounts. Future performance is unmeasured.",
      transportOnlyBaseline: normal,
      provenCoveragePruning: removable,
      additionallyFreeOldAndNewCompilation: criticalPath(freeCompilation, covered),
      additionallyFreeAllRepairs: criticalPath(freeAllRepair, covered),
      freeEverythingExceptResidualInitialPlanning: criticalPath(freeEverythingExceptResidualPlanning, covered),
      requestDurations: primary.http.map((h) => ({ ...h, parents: dag.parents[h.id], eliminated: removable.removed.includes(h.id) })),
      dependencyEvidence: dag.dependencyEvidence,
    },
    outcome: {
      historicalCommitRevision: source.historicalCommit.revision,
      historicalEvents: source.historicalCommit.events.length,
      historicalOperationKinds: counts(source.historicalCommit.operations.map((o) => o.kind)),
      historicalOutcomes: counts(source.historicalCommit.outcomes.map((o) => o.status)),
      simulatedSeconds: source.historicalCommit.temporalBoundary.deltaSeconds,
      dueActivities: source.historicalCommit.temporalBoundary.dueActivityIds.length,
      externalPlayer: primary.externalActorId, misleadingAutonomousName: "player",
      lodging: { usefulFeedback: false, goalAchieved: false, tUsefulMs: null, tGoalMs: null,
        qualification: "Source-reviewed negative: no inquiry/answer/delivery event and no actionable lodging information; succeeded prose is insufficient.",
        recordedPlayer: primary.historicalPlayer },
      otherAgents: "48 continuing outcomes are not declared incorrect merely because physical effects are absent. Their semantic correctness remains unassessed.",
    },
    actorRows, ledger,
    gatedStages: { oracleExecution: "not-run: prerequisite latency space absent", P1: "not-run: P0 failed", P2: "not-run: P0 failed", W1: "not-created" },
  };
}

function main() {
  const [inventoryFile, annotationsFile, dagFile, output] = process.argv.slice(2);
  if (!inventoryFile || !annotationsFile || !dagFile || !output) throw new Error("usage: step-executable-interaction-report.ts INVENTORY ANNOTATIONS DAG NEW-OUTPUT-DIRECTORY");
  const load = <T,>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
  const dag = load<Dag>(dagFile);
  if (sha256(readFileSync(inventoryFile)) !== dag.inventorySha256) throw new Error("Frozen inventory hash mismatch");
  const report = makeReport(load<Inventory>(inventoryFile), load<Annotations>(annotationsFile), dag);
  mkdirSync(output, { recursive: true });
  const file = path.join(output, "report.json");
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  const columns = ["actorId", "phase", "currentBoundary", "pointer", "targetIds", "startUtf16", "endUtf16", "text", "coverage", "work", "deterministicOperations", "prerequisites", "residual", "expected"];
  const cell = (v: unknown) => `"${(Array.isArray(v) ? JSON.stringify(v) : String(v)).replaceAll('"', '""')}"`;
  const rows = report.ledger.flatMap((r) => r.clauses.map((c) => ({ ...r, ...c })));
  writeFileSync(path.join(output, "clauses.csv"), `${[columns.map(cell).join(","), ...rows.map((r) => columns.map((k) => cell(r[k as keyof typeof r])).join(","))].join("\n")}\n`, { flag: "wx" });
  console.log(JSON.stringify({ file, sha256: sha256(readFileSync(file)), decision: report.decision, workload: report.workload,
    latencyMs: Object.fromEntries(Object.entries(report.latency).filter(([, v]) => v && typeof v === "object" && "ms" in v).map(([k, v]) => [k, (v as { ms: number }).ms])) }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
