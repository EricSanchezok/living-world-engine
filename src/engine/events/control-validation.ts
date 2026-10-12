import type { ModelExecutionAudit, SimulationState } from "../contracts/model";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import { contentHash } from "../models/model-audit";
import { validateDecisionResult } from "../models/decision";
import { admitProgram } from "../programs/definition";
import { ProgramInterpreter, type ProgramPredicateWork } from "../programs/interpreter";
import { programPredicateBatch, type DecisionUse } from "../programs/decision-runtime";
import { privateProgramEntityIds, privateProgramResources, privateProgramSources } from "../programs/private-resources";
import type { ExternalActionInput, PolicyBinding } from "../runtime/execution";
import type { JsonObject } from "../runtime/json";
import { validateModelAudit } from "../runtime/transaction";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { issueProgramAttempt } from "./attempt";
import { readDecisionEventState, programReceiptIndex, type DecisionEventState } from "./runtime-state";
import { worldResources } from "./resources";
import { externalWorldAttempt } from "./external-action";

const equal = (a: unknown, b: unknown) => contentHash(a) === contentHash(b);
function creationEvidence(audits: ModelExecutionAudit[], owner: string, output: unknown, profile: string, ids?: string[]) {
  return audits.some(audit => audit.role === "creation" && audit.subjectId === owner && audit.profileId === profile &&
    (!ids || equal(audit.invocations.map(invocation => invocation.id), ids)) &&
    audit.invocations.some(invocation => invocation.normalizedOutputHash === contentHash(output)));
}

/** Re-execute each newly appended private instruction against its owner's actual input. */
export function validateControlTransition(source: Readonly<SimulationState>, before: DecisionEventState, after: DecisionEventState,
  authority: WorldRuntimeContract, producerHash: string, decisions: DecisionUse[], audits: ModelExecutionAudit[],
  roster: Readonly<Record<string, PolicyBinding>>, externalActions: readonly ExternalActionInput[] = []) {
  readDecisionEventState({ producerHash, data: after as unknown as JsonObject }, source);
  for (const key of ["worldHash", "modelCatalogHash", "registryHash", "models", "receipts"] as const) {
    if (!equal(before[key], after[key])) throw new Error(`private control changed pinned ${key}`);
  }
  if (!equal(after.worldResources, worldResources(source, authority, before.worldResources))) throw new Error("world preparation used noncanonical resources");
  for (const audit of audits) {
    validateModelAudit(audit, "decision event");
    if (audit.modelCatalogHash !== after.modelCatalogHash || audit.registrySnapshotHash !== after.registryHash) throw new Error("decision event model identity changed");
  }
  for (const use of decisions) {
    validateDecisionResult(use.batch, use.result);
    if (use.evidenceHash !== contentHash(use.result)) throw new Error("decision evidence hash mismatch");
    const audit = use.result.audit;
    validateModelAudit(audit, "program decision");
    if (audit.registrySnapshotHash !== after.registryHash || audit.modelCatalogHash !== after.modelCatalogHash ||
      audit.profileId !== (use.result.fallback ? after.models.fallback : after.models.decision)) throw new Error("decision used another pinned model");
    if (!use.reused && !audits.some(value => equal(value, audit))) throw new Error("new decision has no physical invocation audit");
    if (use.reused) {
      const cached = before.decisionCache?.entries as unknown as Array<{ result: unknown }> | undefined;
      if (!cached?.some(entry => equal(entry.result, use.result)) && !audits.some(value => equal(value, audit))) {
        throw new Error("reused decision has no previous physical invocation");
      }
    }
    if (use.batch.programHash === contentHash("program-goal-selection-v2")) {
      if (use.batch.view.kind !== "agent" || !source.agents[use.batch.view.agentId]) throw new Error("goal choice has no authorized owner");
      const agent = source.agents[use.batch.view.agentId]!, input = use.batch.state as unknown as { perspective: unknown };
      if (!equal(input.perspective, projectAgentPerspective(source as SimulationState, agent))) throw new Error("goal selection used a foreign perspective");
      const dependencies = Object.fromEntries(Object.entries(after.agents[agent.id]!.resources.resources).map(([key, resource]) => [key, resource.version]));
      if (!equal(use.batch.dependencies, dependencies)) throw new Error("goal selection dependency versions changed");
    }
  }
  for (const entry of before.privateLibrary.entries) {
    if (!after.privateLibrary.entries.some(value => equal(value, entry))) throw new Error("an immutable private program was removed or rewritten");
  }
  for (const entry of before.worldLibrary.entries) {
    const current = after.worldLibrary.entries.find(value => value.signature === entry.signature);
    if (!current) throw new Error("a world program disappeared from the library");
  }
  const receipts = programReceiptIndex(before), actualIssued = new Map<string, ReturnType<typeof issueProgramAttempt>>();
  for (const agent of Object.values(source.agents)) {
    if (after.policyKinds[agent.id] !== roster[agent.id]?.kind) throw new Error("private policy kind differs from the authorized roster");
    const owner = after.agents[agent.id]; if (!owner) throw new Error("private program owner disappeared");
    const perspective = projectAgentPerspective(source as SimulationState, agent);
    const resources = privateProgramResources(perspective, before.agents[agent.id]?.resources);
    if (!equal(owner.resources, resources)) throw new Error("private resource projection differs from the owner's knowledge");
    const planningInput = contentHash(Object.fromEntries(Object.entries(resources.resources).filter(([key]) => key !== "clock")
      .map(([key, value]) => [key, value.value])));
    const planned = decisions.filter(use => use.batch.programHash === contentHash("program-goal-selection-v2") &&
      use.batch.view.kind === "agent" && use.batch.view.agentId === agent.id && use.result.answers.goal?.choice !== "wait").length;
    const priorPlanning = before.agents[agent.id]?.planning;
    if (planned && (owner.planning?.inputHash !== planningInput || owner.planning.attempts !==
      (priorPlanning?.inputHash === planningInput ? priorPlanning.attempts : 0) + planned)) throw new Error("private expansion budget differs from actual planning work");
    const oldInstances = before.agents[agent.id]?.instances ?? [];
    if (oldInstances.some(old => !owner.instances.some(value => value.snapshot.instanceId === old.snapshot.instanceId))) throw new Error("program history was deleted");
    for (const entry of owner.instances) {
      const previous = oldInstances.find(value => value.snapshot.instanceId === entry.snapshot.instanceId);
      const definition = after.privateLibrary.entries.find(value => value.program.hash === entry.snapshot.definitionHash);
      if (!definition || definition.program.definition.owner.agentId !== agent.id) throw new Error("private program ownership changed");
      if (previous && (!equal(previous.entityIds, entry.entityIds) || !equal(previous.snapshot.events, entry.snapshot.events.slice(0, previous.snapshot.events.length)))) {
        throw new Error("private program journal prefix changed");
      }
      if (!previous) {
        if (roster[agent.id]?.kind !== "model") throw new Error("model program cannot control this participant");
        const sources = privateProgramSources(perspective);
        const admitted = admitProgram(definition.program.definition, { ownerId: agent.id, sources: new Map(Object.entries(sources).map(([key, value]) => [key, contentHash(value)])),
          resources: new Set(Object.keys(resources.resources)), goalIds: new Set(Object.keys(agent.character.goals)) });
        if (!equal(admitted, definition.program) || !equal(entry.entityIds, privateProgramEntityIds(perspective)) ||
          entry.snapshot.startedAtSeconds !== source.truth.elapsedSeconds ||
          !before.privateLibrary.entries.some(prior => equal(prior, definition) && equal(prior.parameters, entry.snapshot.parameters)) &&
          !creationEvidence(audits, agent.id, { definition: admitted.definition, parameters: entry.snapshot.parameters }, after.models.creation, definition.creationInvocationIds)) {
          throw new Error("new private program has no authorized creation evidence");
        }
      }
      const interpreter = previous ? ProgramInterpreter.restore(previous.snapshot, definition.program, new Set(previous.entityIds), receipts)
        : new ProgramInterpreter(definition.program, entry.snapshot.instanceId, entry.snapshot.parameters, new Set(entry.entityIds), entry.snapshot.startedAtSeconds);
      const proofTickets = new Map<string, { verdict: string; evidenceHash: string }>();
      for (const event of entry.snapshot.events.slice(previous?.snapshot.events.length ?? 0)) {
        if (roster[agent.id]?.kind !== "model" && !(event.kind === "interrupt" &&
          event.reason === `controller:${roster[agent.id]?.kind}` && before.policyKinds[agent.id] !== after.policyKinds[agent.id])) {
          throw new Error("model changed a non-model participant program");
        }
        const now = source.truth.elapsedSeconds;
        if (event.kind === "settle") throw new Error("private preparation cannot invent a canonical receipt");
        if (event.atSeconds !== now) throw new Error("private control instruction changed canonical time");
        if (event.kind === "predicate") {
          const work = interpreter.work(resources.resources, now).find(value => value.id === event.ticket);
          if (!work || work.kind !== "predicate") throw new Error("predicate is outside the actual program frontier");
          if (work.mechanicalVerdict !== null) {
            if (event.evidenceHash !== contentHash({ evaluator: "program-arithmetic-v1", work, verdict: work.mechanicalVerdict })) throw new Error("mechanical evidence mismatch");
          } else if (!proofTickets.has(event.ticket)) {
            const use = decisions.find(value => value.programInstanceId === interpreter.instanceId && value.evidenceHash === event.evidenceHash &&
              value.programWorkIds?.some(group => group.includes(event.ticket)));
            if (!use?.programWorkIds) throw new Error("private condition has no source-bound decision");
            const frontier = interpreter.work(resources.resources, now);
            const groups = use.programWorkIds.map(group => group.map(id => {
              const item = frontier.find(value => value.id === id);
              if (!item || item.kind !== "predicate" || item.mechanicalVerdict !== null) throw new Error("decision includes an unavailable condition");
              return item as ProgramPredicateWork;
            }));
            if (!equal(programPredicateBatch(interpreter, groups), use.batch)) throw new Error("private decision contains a different authorized input");
            groups.forEach((group, index) => group.forEach(item => proofTickets.set(item.id, {
              verdict: use.result.answers[`q${index}`]!.choice, evidenceHash: use.evidenceHash })));
          }
          if (work.mechanicalVerdict === null && (!proofTickets.has(event.ticket) || proofTickets.get(event.ticket)!.verdict !== event.verdict ||
            proofTickets.get(event.ticket)!.evidenceHash !== event.evidenceHash)) throw new Error("predicate verdict differs from its decision");
          interpreter.resolve(work, resources.resources, event.verdict, event.evidenceHash, now);
        } else if (event.kind === "utterance" || event.kind === "issue" || event.kind === "deadline") {
          const work = interpreter.work(resources.resources, now).find(value => value.id === event.workId);
          if (!work || work.kind === "predicate") throw new Error("instruction is outside the actual program frontier");
          if (event.kind === "utterance") {
            if (!creationEvidence(audits, agent.id, { text: event.text }, after.models.creation)) throw new Error("utterance has no pre-action creation evidence");
            interpreter.supplyUtterance(work, event.text, resources.resources, now);
          } else if (event.kind === "issue") {
            const attempt = issueProgramAttempt(source, interpreter, work, resources.resources);
            if (attempt.program!.requestHash !== event.requestHash) throw new Error("issued attempt payload changed");
            actualIssued.set(attempt.id, attempt);
          } else interpreter.expire(work, now);
        } else if (event.kind === "interrupt") interpreter.interrupt(event.reason, now);
        else interpreter.resume(now);
      }
      if (!equal(interpreter.snapshot(), entry.snapshot)) throw new Error("program journal does not deterministically replay");
    }
  }
  for (const pending of after.pending) {
    const old = before.pending.find(value => value.attempt.id === pending.attempt.id);
    if (pending.attempt.program && !old && !equal(actualIssued.get(pending.attempt.id), pending.attempt)) throw new Error("world attempt has no issued private instruction");
    if (old && !equal({ ...old.attempt, startedAtSeconds: pending.attempt.startedAtSeconds }, pending.attempt)) throw new Error("a pending attempt was rewritten");
    if (!old && !pending.attempt.program) {
      const action = externalActions.find(action => action.agentId === pending.attempt.actorId &&
        externalWorldAttempt(source, action, pending.attempt.utterance).id === pending.attempt.id);
      if (!action || roster[action.agentId]?.kind !== "external" ||
        !equal(externalWorldAttempt(source, action, pending.attempt.utterance), pending.attempt) ||
        !creationEvidence(audits, action.agentId, { utterance: pending.attempt.utterance }, after.models.creation)) throw new Error("world attempt has no authorized player submission");
    }
  }
  for (const pending of before.pending) if (!after.pending.some(value => value.attempt.id === pending.attempt.id)) {
    const changed = before.policyKinds[pending.attempt.actorId] !== after.policyKinds[pending.attempt.actorId] ||
      externalActions.some(action => action.agentId === pending.attempt.actorId);
    const interruptible = pending.failure || !pending.bound || source.truth.mechanics.temporalProfiles[pending.bound.program.definition.timing.profileId]?.interruptible;
    if (!changed || roster[pending.attempt.actorId]?.kind === "model" || !interruptible) throw new Error("pending action disappeared without authorized interruption");
  }
}
