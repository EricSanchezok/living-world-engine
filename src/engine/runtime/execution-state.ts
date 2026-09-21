import { z } from "zod";
import { assertJsonValue, type JsonObject } from "./json";

/** Private control state owned by one exact root Composition. It is persisted
 * with world commits but does not grant authority over world effects or beliefs. */
export interface AlgorithmExecutionState {
  producerHash: string;
  data: JsonObject;
}

export function validateAlgorithmExecutionState(value: unknown, producerHash?: string): asserts value is AlgorithmExecutionState | null {
  if (value === null) return;
  assertJsonValue(value, "algorithm execution state");
  const parsed = z.strictObject({ producerHash: z.string().regex(/^[a-f0-9]{64}$/u), data: z.record(z.string(), z.unknown()) }).parse(value);
  assertJsonValue(parsed.data, "algorithm execution state");
  if (producerHash !== undefined && parsed.producerHash !== producerHash) throw new Error("algorithm execution state belongs to another Composition");
}
