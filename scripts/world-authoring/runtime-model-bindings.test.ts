import { describe, expect, it } from "vitest";
import { bindRuntimeModels } from "./runtime-model-bindings";

describe("operational runtime model binding", () => {
  it("binds every materialized Agent and origin while preserving approved story content", () => {
    const old = { decision: "old-decision", creation: "old-creation", fallback: "old-fallback" };
    const profiles = { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek" };
    const source = { manifest: { model_profiles: old }, entities: [{ agent: { model_profiles: old, privateGoal: "Keep the entrusted herbs intact" } }],
      participation: { origins: [{ initialization: { entities: [{ agent: { model_profiles: old, secret: "A private quote" } }] } }] },
      facts: [{ value: "decision-deepseek", description: "A story string is not a model binding" }] };
    const original = structuredClone(source), bound = bindRuntimeModels(source, profiles);
    expect(source).toEqual(original);
    expect(bound.manifest.model_profiles).toEqual(profiles);
    expect(bound.entities[0]!.agent.model_profiles).toEqual(profiles);
    expect(bound.participation.origins[0]!.initialization.entities[0]!.agent.model_profiles).toEqual(profiles);
    expect(bound.entities[0]!.agent.privateGoal).toBe(source.entities[0]!.agent.privateGoal);
    expect(bound.participation.origins[0]!.initialization.entities[0]!.agent.secret).toBe("A private quote");
    expect(bound.facts).toEqual(source.facts);
    expect(bindRuntimeModels(bound, old)).toEqual(source);
  });
});
