import { programGoalSelection } from "./goal-selection";
import { agentEventModels } from "./model-bindings";
import type { ModelExecutionAudit, SimulationState } from "../contracts/model";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import { contentHash } from "../models/model-audit";
import type { ModelExecutionScope, StructuredModelProvider } from "../models/model-provider";
import { compileAgentProgram } from "../programs/compiler";
import { DecisionRuntime, resolveProgramPredicates, type DecisionUse } from "../programs/decision-runtime";
import { ProgramInterpreter } from "../programs/interpreter";
import { ProgramLibrary } from "../programs/library";
import { privateProgramEntityIds, privateProgramResources, privateProgramSources, resourceValues } from "../programs/private-resources";
import { createProgramUtterance } from "../programs/utterance";
import { adaptationReasonPrefix, programAdaptationBatch } from "../programs/adaptation";
import { programRevisionContext } from "../programs/revision-context";
import { privatePlanningInput } from "../programs/planning-input";
import type { PolicyBinding } from "../runtime/execution";
import type { JsonObject, JsonValue } from "../runtime/json";
import { issueProgramAttempt } from "./attempt";
import { EventScheduler } from "./scheduler";
import { collectDecisionAudits, collectDecisionUses, restoreOwnerPrograms, sealDecisionEventState, type DecisionEventState } from "./runtime-state";

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
export interface ProgramControlResult {
  control: DecisionEventState;
  modelAudits: ModelExecutionAudit[];
  decisions: DecisionUse[];
  activatedAgentIds: string[];
}

/** Model work runs only for the local frontier. This function changes private control, never canonical truth. */
export async function advanceProgramControls(provider: StructuredModelProvider, source: Readonly<SimulationState>,
  initial: DecisionEventState, roster: Readonly<Record<string, PolicyBinding>>, scope: ModelExecutionScope,
  options: { maxDependencyRounds: number; nextInvocation: (subjectId: string, slots?: number) => number }): Promise<ProgramControlResult> {
  if (!Number.isSafeInteger(options.maxDependencyRounds) || options.maxDependencyRounds < 1) throw new Error("program dependency round budget must be positive");
  if (initial.modelCatalogHash !== provider.catalog.hash || scope.modelRegistrySnapshotHash && scope.modelRegistrySnapshotHash !== initial.registryHash) {
    throw new Error("program execution model binding changed");
  }
  scope = { ...scope, modelRegistrySnapshotHash: initial.registryHash, runtimeIdentity: { worldHash: source.worldHash, revision: source.revision } };
  const control = structuredClone(initial), scheduler = new EventScheduler(source.truth.elapsedSeconds, control.scheduler);
  const runtime = new DecisionRuntime(provider, control.decisionCache ?? undefined), library = new ProgramLibrary(control.privateLibrary);
  const audits: ModelExecutionAudit[] = [], decisions: DecisionUse[] = [], activatedAgentIds: string[] = [];
  const now = source.truth.elapsedSeconds;
  for (const agentId of Object.keys(source.agents).sort()) {
    const kind = roster[agentId]?.kind;
    if (!kind) throw new Error("program policy roster is incomplete");
    if (control.policyKinds[agentId] === kind) continue;
    control.policyKinds[agentId] = kind;
    if (kind === "model") scheduler.schedule({ atSeconds: now, subjectId: agentId, kind: "control",
      inputHash: contentHash({ policy: kind, revision: source.revision }), payload: { reason: "controller-resumed" } });
    else {
      const owner = control.agents[agentId];
      for (const program of restoreOwnerPrograms(control, agentId)) if (program.status !== "ended" && program.status !== "interrupted") {
        program.interrupt(`controller:${kind}`, now);
        owner!.instances.find(entry => entry.snapshot.instanceId === program.instanceId)!.snapshot = program.snapshot();
      }
      if (owner) owner.activeInstanceId = null;
      // Unstarted plans can be revoked immediately. Started noninterruptible work retains its boundary.
      const cancelled = new Set(control.pending.filter(pending => pending.attempt.actorId === agentId &&
        (!pending.bound || source.truth.mechanics.temporalProfiles[pending.bound.program.definition.timing.profileId]?.interruptible))
        .map(pending => pending.attempt.id));
      control.pending = control.pending.filter(pending => !cancelled.has(pending.attempt.id));
      for (const queued of scheduler.snapshot().pending) if (queued.kind === "world" && cancelled.has((queued.payload as { attemptId: string }).attemptId)) scheduler.cancel(queued.id);
      scheduler.unsubscribe(agentId);
    }
  }
  for (const agent of Object.values(source.agents)) {
    const prior = control.agents[agent.id], resources = privateProgramResources(projectAgentPerspective(source as SimulationState, agent), prior?.resources);
    if (prior) { prior.resources = resources; scheduler.notify(agent.id, resources.resources); }
    else {
      control.agents[agent.id] = { resources, instances: [], activeInstanceId: null, planning: null, lastEvidenceIds: Object.keys(agent.belief.evidence).sort() };
      scheduler.schedule({ atSeconds: now, subjectId: agent.id, kind: "control", inputHash: contentHash({ admitted: agent.id }),
        payload: { reason: "new-agent-goal-coverage" } });
    }
  }
  const frontier = scheduler.nextTime === now ? scheduler.frontier().filter(event => event.kind !== "world" && event.subjectId !== null) : [];
  const waking = [...new Set(frontier.map(event => event.subjectId!))].sort();
  if (frontier.length) scheduler.acknowledge(frontier.map(event => event.id), now);
  const subscriptions: Array<{ ownerId: string; keys: string[]; receipts: string[]; deadline: number | null }> = [];
  const continuations: Array<{ ownerId: string; hash: string }> = [];
  const cancelledAttempts = new Set<string>();
  const record = (use: DecisionUse) => { decisions.push(use); if (!use.reused) audits.push(use.result.audit); };
  const settled = await Promise.allSettled(waking.map(async ownerId => {
    const agent = source.agents[ownerId], policy = roster[ownerId];
    if (!agent || policy?.kind !== "model") return;
    const perspective = projectAgentPerspective(source as SimulationState, agent);
    const models = agentEventModels(source, control, ownerId);
    const owner = control.agents[ownerId] ?? { resources: privateProgramResources(perspective), instances: [], activeInstanceId: null, planning: null,
      lastEvidenceIds: Object.keys(agent.belief.evidence).sort() };
    control.agents[ownerId] = owner;
    owner.resources = privateProgramResources(perspective, owner.resources);
    const resources = owner.resources.resources, interpreters = restoreOwnerPrograms(control, ownerId);
    const inputHash = contentHash(resources);
    const planningInput = privatePlanningInput(resources);
    if (owner.planning?.inputHash !== planningInput) owner.planning = { inputHash: planningInput, attempts: 0, waitReason: null };
    if (!scheduler.beginEvaluation(ownerId, inputHash, contentHash(owner.instances), contentHash({ evidence: agent.belief.evidence,
      receipts: control.receipts.flatMap(receipt => receipt.programReceipts.filter(receipt => owner.instances.some(instance => instance.snapshot.instanceId === receipt.instanceId))) }))) return;
    activatedAgentIds.push(ownerId);
    let active = interpreters.find(interpreter => interpreter.instanceId === owner.activeInstanceId);
    if (active?.status === "ended") {
      const resolved = await resolveProgramPredicates(runtime, active, resources, now, { ...scope, profileId: models.decision,
        fallbackProfileId: models.fallback, nextInvocation: () => options.nextInvocation(ownerId) });
      resolved.decisions.forEach(record);
    }
    const { goals, reusable, batch } = programGoalSelection(agent, perspective, resources, interpreters, library);
    if ((!active || active.status === "needs-expansion" || active.status === "ended" || active.status === "interrupted") && goals.length &&
      !control.pending.some(pending => pending.attempt.actorId === ownerId) && owner.planning!.attempts < 2) {
      const selected = await runtime.decide({ ...scope, profileId: models.decision, fallbackProfileId: models.fallback,
        batch, subjectId: ownerId, modelInvocation: options.nextInvocation(ownerId) }); record(selected);
      const choice = selected.result.answers.goal!.choice;
      const reuse = /^p\d+$/u.test(choice) ? reusable[Number(choice.slice(1))] : undefined;
      const goal = /^g\d+$/u.test(choice) ? goals[Number(choice.slice(1))] : undefined;
      if (choice !== "wait" && !goal && !reuse) throw new Error("goal decision escaped its actual domain");
      owner.planning!.waitReason = choice === "wait" ? "waiting-for-relevant-evidence" : null;
      if (goal || reuse) {
        owner.planning!.attempts += 1;
        const compiled = reuse ? { status: "ready" as const, program: reuse.program, parameters: reuse.parameters }
          : await compileAgentProgram(provider, { ...scope, profileId: models.creation, ownerId, goalId: goal!.id,
            intent: goal!.description, reason: active ? "revision" : "initial-coverage", perspective: json(perspective),
            priorProgram: active ? programRevisionContext(active) : null,
            resources: resourceValues(resources), sources: privateProgramSources(perspective),
            goalIds: Object.keys(agent.character.goals), entityIds: privateProgramEntityIds(perspective), invocationBase: options.nextInvocation(ownerId, 2) });
        if ("audit" in compiled && compiled.audit) audits.push(compiled.audit);
        if (compiled.status === "ready") {
          if ("audit" in compiled) library.add(compiled);
          control.privateLibrary = library.snapshot();
          const instanceId = contentHash({ ownerId, program: compiled.program.hash, count: owner.instances.length, inputHash });
          const entityIds = privateProgramEntityIds(perspective);
          active = new ProgramInterpreter(compiled.program, instanceId, compiled.parameters, new Set(entityIds), now);
          interpreters.push(active); owner.instances.push({ snapshot: active.snapshot(), entityIds }); owner.activeInstanceId = instanceId;
        } else control.failures.push({ ownerId, phase: "program", inputHash, reason: compiled.reason, recoverable: true });
      }
    }

    if (active && active.status !== "interrupted") {
      for (let round = 0; round < options.maxDependencyRounds; round += 1) {
        const before = active.snapshot().hash, work = active.work(resources, now);
        if (!work.length) break;
        if (work.some(item => item.kind === "predicate")) {
          const resolved = await resolveProgramPredicates(runtime, active, resources, now, { ...scope,
            profileId: models.decision, fallbackProfileId: models.fallback, nextInvocation: () => options.nextInvocation(ownerId) });
          resolved.decisions.forEach(record);
        }
        const nextWork = active.work(resources, now);
        if (nextWork.some(item => item.kind === "predicate")) {
          if (round === options.maxDependencyRounds - 1) continuations.push({ ownerId, hash: active.snapshot().hash });
          continue;
        }
        for (const item of nextWork) {
          if (item.kind === "predicate") continue;
          if (item.kind === "deadline") { active.expire(item, now); continue; }
          if (item.kind === "utterance") {
            const created = await createProgramUtterance(provider, { ...scope, profileId: models.creation,
              invocationBase: options.nextInvocation(ownerId, 2), perspective, work: item });
            if (created.audit) audits.push(created.audit);
            if (created.status === "ready") active.supplyUtterance(item, created.text, resources, now);
            else {
              control.failures.push({ ownerId, phase: "utterance", inputHash, reason: created.reason, recoverable: true });
              break;
            }
          } else {
            try {
              const attempt = issueProgramAttempt(source, active, item, resources);
              control.pending.push({ attempt, bound: null, atSeconds: null, dependencyHash: "", failure: null, recovery: null });
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              active.interrupt(reason, now);
              control.failures.push({ ownerId, phase: "program", inputHash, reason, recoverable: true });
              break;
            }
          }
        }
        if (active.snapshot().hash === before || control.pending.some(pending => pending.attempt.actorId === ownerId)) break;
        if (round === options.maxDependencyRounds - 1) continuations.push({ ownerId, hash: active.snapshot().hash });
      }
    }
    if (active && !control.pending.some(pending => pending.attempt.actorId === ownerId)) {
      const batch = programAdaptationBatch(active, resources, now);
      if (batch) {
        const use = await runtime.decide({ ...scope, profileId: models.decision, fallbackProfileId: models.fallback,
          batch, subjectId: ownerId, modelInvocation: options.nextInvocation(ownerId) });
        use.programInstanceId = active.instanceId; record(use);
        if (use.result.answers.adaptation!.choice === "revise") active.interrupt(`${adaptationReasonPrefix}${use.evidenceHash}`, now);
      }
    }
    if (active?.status === "interrupted") {
      for (const pending of control.pending.filter(pending => pending.attempt.program?.instanceId === active!.instanceId)) {
        if (!pending.bound || source.truth.mechanics.temporalProfiles[pending.bound.program.definition.timing.profileId]?.interruptible) {
          cancelledAttempts.add(pending.attempt.id);
        }
      }
      control.pending = control.pending.filter(pending => !cancelledAttempts.has(pending.attempt.id));
    }
    if ((active?.status === "needs-expansion" || active?.status === "interrupted") && !control.pending.some(pending => pending.attempt.actorId === ownerId)) {
      if (owner.planning!.attempts < 2) continuations.push({ ownerId, hash: active.snapshot().hash });
      else if (owner.planning!.waitReason !== "expansion-budget-exhausted") {
        owner.planning!.waitReason = "expansion-budget-exhausted";
        control.failures.push({ ownerId, phase: "program", inputHash: planningInput,
          reason: "No new evidence after one targeted plan revision; wait for a relevant change.", recoverable: true });
      }
    }
    for (const interpreter of interpreters) {
      const entry = owner.instances.find(value => value.snapshot.instanceId === interpreter.instanceId)!;
      entry.snapshot = interpreter.snapshot();
    }
    const watched = interpreters.filter(interpreter => interpreter.instanceId === owner.activeInstanceId)
      .map(interpreter => interpreter.subscriptions(resources, now));
    const keys = [...new Set(watched.flatMap(value => value.resources))];
    // With no active plan, new private evidence and goals can end a deliberate wait or repair a failed compilation.
    if (!watched.length || active?.status === "needs-expansion" || active?.status === "interrupted") keys.push(...Object.keys(resources).filter(key => key !== "clock"));
    const deadlines = watched.flatMap(value => value.deadline === null ? [] : [value.deadline]);
    subscriptions.push({ ownerId, keys, receipts: watched.flatMap(value => value.receiptWorkIds), deadline: deadlines.length ? Math.min(...deadlines) : null });
  }));
  const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "private program control failed");
  for (const queued of scheduler.snapshot().pending) if (queued.kind === "world" && cancelledAttempts.has((queued.payload as { attemptId: string }).attemptId)) scheduler.cancel(queued.id);
  for (const value of subscriptions.sort((a, b) => a.ownerId.localeCompare(b.ownerId))) scheduler.subscribe(value.ownerId,
    control.agents[value.ownerId]!.resources.resources, value.keys, value.receipts, value.deadline);
  for (const value of continuations.sort((a, b) => a.ownerId.localeCompare(b.ownerId))) scheduler.schedule({ atSeconds: now,
    subjectId: value.ownerId, kind: "control", inputHash: value.hash, payload: { reason: "program-control-continuation" } });
  control.pending.sort((a, b) => a.attempt.id.localeCompare(b.attempt.id));
  control.failures.sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.inputHash.localeCompare(b.inputHash));
  control.privateLibrary = library.snapshot(); control.scheduler = scheduler.snapshot(); control.decisionCache = runtime.snapshot() as unknown as JsonObject;
  control.coverage = Object.values(source.agents).flatMap(agent => {
    const owner = control.agents[agent.id]; if (!owner) return [];
    return library.coverage(agent.id, Object.values(agent.character.goals).filter(goal => goal.status === "active").map(goal => goal.id),
      restoreOwnerPrograms(control, agent.id), owner.resources.resources, now).map(row => row.status === "needs-generation" &&
        owner.planning?.waitReason === "waiting-for-relevant-evidence" ? { ...row, status: "waiting" as const, reasons: [owner.planning.waitReason] } : row);
  });
  return { control: sealDecisionEventState(control), modelAudits: collectDecisionAudits(audits), decisions: collectDecisionUses(decisions), activatedAgentIds: activatedAgentIds.sort() };
}
