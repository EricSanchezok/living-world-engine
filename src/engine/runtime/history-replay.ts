import type { HistoryReplayBase, SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";

export function createHistoryReplayBase(state: SimulationState): HistoryReplayBase {
  if (state.historyBase) return structuredClone(state.historyBase);
  return {
    executionState: structuredClone(state.executionState),
    truth: structuredClone(state.truth),
    agents: Object.fromEntries(Object.values(state.agents)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((agent) => [agent.id, structuredClone(agent)])),
  };
}

export function historyReplayBaseHash(state: SimulationState): string {
  return contentHash(createHistoryReplayBase(state));
}
