import type { SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { applyJsonDelta, createJsonDelta, type JsonDelta } from "../runtime/json-delta";
import type { JsonValue } from "../runtime/json";
import type { DecisionEventStep } from "./execution-contract";

export interface StoredDecisionEventStep extends Omit<DecisionEventStep, "version" | "authority" | "preparedControl" | "activityAdmissionInput" | "finalControl"> {
  version: 2;
  authorityHash: string;
  prepared: JsonDelta;
  admission: JsonDelta;
  settled: JsonDelta;
}

const json = (value: unknown) => value as JsonValue;

/** Immutable definitions and prior evidence are already present in the source checkpoint. */
export function storeDecisionEventStep(source: Readonly<SimulationState>, proof: DecisionEventStep): StoredDecisionEventStep {
  if (!source.executionState || !source.bootstrapDecisionEvent ||
    contentHash(source.bootstrapDecisionEvent.authority) !== contentHash(proof.authority)) throw new Error("native journal has no pinned authority");
  const { authority, preparedControl, activityAdmissionInput, finalControl, ...rest } = proof;
  return { ...rest, version: 2, authorityHash: contentHash(authority),
    prepared: createJsonDelta(source.executionState.data, json(preparedControl)),
    admission: createJsonDelta(json(preparedControl.pending), json(activityAdmissionInput)),
    settled: createJsonDelta(json(preparedControl), json(finalControl)) };
}

/** Decoding preserves the complete canonical proof; integrity validation still runs after reconstruction. */
export function restoreDecisionEventStep(source: Readonly<SimulationState>, stored: StoredDecisionEventStep): DecisionEventStep {
  const { prepared, admission, settled, authorityHash, ...rest } = stored;
  if (stored.version !== 2 || !source.executionState || !source.bootstrapDecisionEvent ||
    contentHash(source.bootstrapDecisionEvent.authority) !== authorityHash) throw new Error("native journal authority mismatch");
  const preparedControl = applyJsonDelta(source.executionState.data, prepared) as unknown as DecisionEventStep["preparedControl"];
  return { ...rest, version: 1, authority: structuredClone(source.bootstrapDecisionEvent.authority), preparedControl,
    activityAdmissionInput: applyJsonDelta(json(preparedControl.pending), admission) as unknown as DecisionEventStep["activityAdmissionInput"],
    finalControl: applyJsonDelta(json(preparedControl), settled) as unknown as DecisionEventStep["finalControl"] };
}
