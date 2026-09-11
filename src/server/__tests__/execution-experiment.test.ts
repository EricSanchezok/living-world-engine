import { describe, expect, it } from "vitest";
import {
  parseExperimentMatrix,
  runDeterministicExperiment,
} from "../../../scripts/experiments/experiment-core";

describe("execution experiment core", () => {
  it("runs the small deterministic CI scenario without a remote model", async () => {
    const result = await runDeterministicExperiment({ agents: [1], steps: [1] });
    expect(result.scenarios).toEqual([expect.objectContaining({
      agents: 1,
      steps: 1,
      modelInvocations: 9,
      instanceDocumentBytes: expect.any(Number),
      ledgerEventCount: 0,
    })]);
    expect(result.scenarios[0].instanceDocumentBytes).toBeGreaterThan(0);
    expect(result.records.at(-1)).toMatchObject({
      schemaVersion: 3,
      event: "experiment.summary",
      kind: "deterministic-eager-reference",
    });
    expect(result.records.some((record) => record.event === "experiment.context")).toBe(true);
    expect(result.records.some((record) => record.event === "experiment.bootstrap")).toBe(true);
    expect(result.records.some((record) => record.event === "experiment.step")).toBe(true);
  });

  it("re-pins the replay base when the experiment fixture adds Agents", async () => {
    const result = await runDeterministicExperiment({ agents: [2], steps: [1] });
    expect(result.scenarios).toEqual([expect.objectContaining({
      agents: 2,
      steps: 1,
      actionCompilationMaxSlots: 12,
      agentMindMaxSlots: 8,
      truthBatchMaxSlots: 12,
      modelInvocations: 13,
      averageActionCompilationSlots: 2,
      averageAgentMindSlots: 2,
    })]);
  });

  it("parses comma-separated matrices and rejects non-positive values", () => {
    expect(parseExperimentMatrix([
      "--agents",
      "50,1,10",
      "--steps=10,1",
      "--action-compilation-slots=12,1,4",
      "--agent-mind-slots",
      "8,1,2",
    ])).toEqual({
      agents: [1, 10, 50],
      steps: [1, 10],
      actionCompilationSlots: [1, 4, 12],
      agentMindSlots: [1, 2, 8],
      truthBatchSlots: [12],
    });
    expect(() => parseExperimentMatrix(["--steps", "0"])).toThrow("positive safe integers");
    expect(() => parseExperimentMatrix(["--steps"])).toThrow("requires a comma-separated value");
    expect(() => parseExperimentMatrix(["--agent-mind-slots=65"])).toThrow("1 through 64");
    expect(() => parseExperimentMatrix(["--unknown", "1"])).toThrow("unknown experiment argument");
  });

  it("runs independent action-compilation and AgentMind slot matrices", async () => {
    const result = await runDeterministicExperiment({
      agents: [2],
      steps: [1],
      actionCompilationSlots: [1, 2],
      agentMindSlots: [1, 2],
    });
    expect(result.scenarios).toHaveLength(4);
    const singleton = result.scenarios.find((scenario) =>
      scenario.actionCompilationMaxSlots === 1 && scenario.agentMindMaxSlots === 1)!;
    const batched = result.scenarios.find((scenario) =>
      scenario.actionCompilationMaxSlots === 2 && scenario.agentMindMaxSlots === 2)!;
    expect(singleton.rolePhysicalCalls).toMatchObject({
      "action-compilation": 2,
      "agent-bootstrap": 2,
      "agent-mind": 2,
    });
    expect(batched.rolePhysicalCalls).toMatchObject({
      "action-compilation": 1,
      "agent-bootstrap": 1,
      "agent-mind": 1,
    });
  });
});
