import type { SimulationState } from "../contracts/model";
import type { ProgramResources } from "../programs/definition";
import { ProgramInterpreter, type ProgramAttemptWork } from "../programs/interpreter";
import { runtimeId } from "../runtime/runtime-id";
import type { WorldAttempt } from "./adjudication";

/** The only crossing from private program references to canonical action bindings. */
export function issueProgramAttempt(state: Readonly<SimulationState>, interpreter: ProgramInterpreter, work: ProgramAttemptWork,
  resources: ProgramResources): WorldAttempt {
  if (work.kind !== "attempt") throw new Error("program work is not an executable attempt");
  const owner = interpreter.program.definition.owner.agentId, agent = state.agents[owner];
  if (!agent || state.truth.entities[agent.entityId]?.lifecycle !== "active") throw new Error("program owner is not an active world Agent");
  const targets = work.targetIds.map(localId => {
    if (!Object.hasOwn(agent.belief.localEntities, localId)) throw new Error("program targets an unknown private entity");
    const binding = agent.bindings[localId];
    if (!binding || binding.canonicalEntityIds.length !== 1 || !state.truth.entities[binding.canonicalEntityIds[0]!]) {
      throw new Error(`program target ${localId} requires identity clarification`);
    }
    return binding.canonicalEntityIds[0]!;
  });
  const requestHash = interpreter.issue(work, resources, state.truth.elapsedSeconds);
  return { id: runtimeId({ worldHash: state.worldHash, revision: state.revision, kind: "action", stage: "program-attempt",
    owner: [interpreter.instanceId, work.id], round: 0, ordinal: 0 }),
    actorId: owner, actorEntityId: agent.entityId, intent: work.intent, utterance: work.utterance, targetEntityIds: targets,
    startedAtSeconds: state.truth.elapsedSeconds, program: { instanceId: interpreter.instanceId, workId: work.id, requestHash } };
}
