import type { SimulationState, WorldDeltaOperation } from "../contracts/model";

/** Validate reference order without evaluating quantities or choosing a conditional branch. */
export function validateWorldOperationReferences(state: Readonly<SimulationState>, operations: readonly WorldDeltaOperation[]) {
  const entities = new Set(Object.keys(state.truth.entities)), facts = new Set(Object.keys(state.truth.facts));
  const meters = new Set(Object.keys(state.truth.meters)), conditions = new Set(Object.keys(state.truth.conditions));
  const agents = new Set(Object.keys(state.agents));
  const requireId = (ids: Set<string>, id: string, kind: string) => {
    if (!ids.has(id)) throw new Error(`world effect references unavailable ${kind} ${id}; create it earlier in the same branch or use an existing reference`);
  };
  const entity = (id: string) => requireId(entities, id, "entity");
  for (const operation of operations) {
    switch (operation.kind) {
      case "create_entity":
        if (operation.placementId) entity(operation.placementId);
        entities.add(operation.entity.id); break;
      case "retire_entity": entity(operation.entityId); break;
      case "place_entity": entity(operation.entityId); if (operation.placementId) entity(operation.placementId); break;
      case "set_fact":
        entity(operation.fact.subjectId);
        if (operation.fact.value.kind === "entity") entity(operation.fact.value.entityId);
        if (operation.fact.access.kind === "agents") operation.fact.access.agentIds.forEach(id => requireId(agents, id, "Agent"));
        facts.add(operation.fact.id); break;
      case "remove_fact": requireId(facts, operation.factId, "fact"); facts.delete(operation.factId); break;
      case "set_meter": entity(operation.meter.entityId); meters.add(operation.meter.id); break;
      case "adjust_meter": requireId(meters, operation.meterId, "meter"); break;
      case "transfer_quantity": entity(operation.fromHolderId); entity(operation.toHolderId); break;
      case "produce_quantity": case "consume_quantity": entity(operation.holderId); break;
      case "set_quantity": entity(operation.quantity.holderId); break;
      case "set_rating": entity(operation.rating.entityId); break;
      case "set_condition": entity(operation.condition.subjectId); conditions.add(operation.condition.id); break;
      case "remove_condition": requireId(conditions, operation.conditionId, "condition"); conditions.delete(operation.conditionId); break;
      case "set_shared_activity_resource_capacity":
        if (!state.truth.sharedActivityResourcePools[operation.poolId]) throw new Error(`unknown shared resource pool ${operation.poolId}`);
        break;
      case "create_agent":
        entity(operation.agent.entityId);
        Object.values(operation.agent.bindings).flatMap(binding => binding.canonicalEntityIds).forEach(entity);
        agents.add(operation.agent.id); break;
      case "remove_agent": requireId(agents, operation.agentId, "Agent"); agents.delete(operation.agentId); break;
      case "advance_time": throw new Error("world program cannot own time advancement");
    }
  }
}
