import type { SimulationState } from "../contracts/model";
import { evaluateCausalAssertion } from "../mechanics/causality";
import { EventScheduler } from "./scheduler";

export interface WorldClockBoundary {
  timers: Array<{ id: string; status: "fired" | "cancelled"; wakeAgentIds: string[] }>;
  conditions: string[];
  programDeadlines: Array<{ eventId: string; agentId: string }>;
}

function programSchedule(state: Readonly<SimulationState>) {
  const data = state.executionState?.data;
  return data?.kind === "decision-event" ? new EventScheduler(state.truth.elapsedSeconds, data.scheduler).snapshot().pending : [];
}

/** Existing canonical deadlines are hard barriers, independent of a caller's scheduler. */
export function nextWorldClockBoundary(state: Readonly<SimulationState>): number | null {
  const times = [
    ...Object.values(state.truth.timers).filter(timer => timer.status === "scheduled").map(timer => timer.dueAtSeconds),
    ...Object.values(state.truth.conditions).flatMap(condition => condition.expiresAtElapsedSeconds === null ? [] : [condition.expiresAtElapsedSeconds]),
    ...programSchedule(state).filter(event => event.kind === "world" || event.kind === "deadline").map(event => event.atSeconds),
  ];
  return times.length ? Math.min(...times) : null;
}

export function worldClockBoundary(state: Readonly<SimulationState>, atSeconds: number): WorldClockBoundary {
  const earliest = nextWorldClockBoundary(state);
  if (earliest !== null && earliest < atSeconds) throw new Error("cannot pass an earlier canonical timer or condition boundary");
  const timed = { ...state, truth: { ...state.truth, elapsedSeconds: atSeconds } } as SimulationState;
  return {
    timers: Object.values(state.truth.timers).filter(timer => timer.status === "scheduled" && timer.dueAtSeconds === atSeconds)
      .sort((a, b) => a.id.localeCompare(b.id)).map(timer => {
        const fires = timer.assertions.every(assertion => evaluateCausalAssertion(timed, assertion).passed);
        return { id: timer.id, status: fires ? "fired" as const : "cancelled" as const, wakeAgentIds: fires ? timer.wakeAgentIds.slice() : [] };
      }),
    conditions: Object.values(state.truth.conditions).filter(condition => condition.expiresAtElapsedSeconds === atSeconds).map(condition => condition.id).sort(),
    programDeadlines: programSchedule(state).filter(event => event.kind === "deadline" && event.atSeconds === atSeconds &&
      event.subjectId !== null && state.agents[event.subjectId]).map(event => ({ eventId: event.id, agentId: event.subjectId! }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId)),
  };
}
