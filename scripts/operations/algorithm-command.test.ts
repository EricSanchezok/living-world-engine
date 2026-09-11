import { describe, expect, it } from "vitest";
import { runAlgorithmCommand } from "./algorithm-command";

describe("algorithm command", () => {
  it("lists, describes, validates, and checks the generated catalog", () => {
    expect(JSON.parse(runAlgorithmCommand(["list"]))).toContainEqual(expect.objectContaining({
      role: "candidate-selection",
      id: "full-catalog",
      availability: "runtime",
    }));
    expect(JSON.parse(runAlgorithmCommand(["list"]))).toContainEqual(expect.objectContaining({
      role: "candidate-selection",
      id: "structure-encoder-hybrid",
      availability: "benchmark-only",
    }));
    expect(JSON.parse(runAlgorithmCommand(["describe", "world-execution/eager-reference@19"]))).toMatchObject({
      definition: { role: "world-execution", id: "eager-reference", version: "19" },
    });
    expect(JSON.parse(runAlgorithmCommand(["describe", "candidate-selection/typed-full@1"]))).toMatchObject({
      definition: { role: "candidate-selection", id: "typed-full", availability: "benchmark-only" },
      defaultCompositionNodes: [],
    });
    expect(JSON.parse(runAlgorithmCommand(["validate"]))).toMatchObject({ valid: true });
    expect(runAlgorithmCommand(["catalog", "--check"])).toBe("algorithm catalog is current\n");
  });
});
