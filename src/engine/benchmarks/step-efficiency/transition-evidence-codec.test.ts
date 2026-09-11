import { expect, it } from "vitest";
import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { evaluateCommittedBehaviorOracle } from "./behavior-oracle";
import { runConditionalCompletionScenario } from "./conditional-scenario";
import { replaySimulationState } from "../../runtime/transaction";
import { TransitionEvidenceCodec } from "./transition-evidence-codec";

it.each(["continuing", "arrived", "invalid"] as const)("expands selected evidence through the real %s world path", async (scenario) => {
  let expandedCalls = 0;
  const world = await runConditionalCompletionScenario(scenario, async (request, fallback) => {
    const generated = await fallback(), codec = new TransitionEvidenceCodec(request.context);
    const wire = structuredClone(generated.value) as { operations: Array<{ kind: string; entityRef: string; assertions: unknown[] }>; outcomes: Array<{ assertions: unknown[] }> };
    if (wire.operations.length) {
      const operation = wire.operations[0]!;
      const fact = codec.inputFacts.find((entry) => operation.kind === "place_entity"
        ? entry.assertion.kind === "placement_equals" && entry.assertion.entityRef === operation.entityRef
        : entry.assertion.kind === "entity_lifecycle" && entry.assertion.entityRef === operation.entityRef);
      expect(fact).toBeDefined();
      operation.assertions = [{ kind: "input_state_fact", key: fact!.key }];
      wire.outcomes[0]!.assertions = [{ kind: "operation_effect", operationIndex: 0 }];
    }
    const schema = codec.schema(z.toJSONSchema(request.schema, { target: "draft-07" }));
    // Hosted JSON-object requests validate after codec expansion with this
    // original Zod schema; fromJSONSchema drops the Unicode regex flag used by
    // reference handles and is not that production validation path.
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(Object.keys(z.toJSONSchema(request.schema, { target: "draft-07" }).properties!));
    const decoded = codec.output(wire, request.context);
    expect(contentHash(codec.output(generated.value, request.context))).toBe(contentHash(generated.value));
    expandedCalls += 1;
    return { ...generated, value: request.schema.parse(decoded) };
  }, true);
  expect(expandedCalls).toBeGreaterThan(0);
  expect(evaluateCommittedBehaviorOracle({ source: world.source, action: world.action, checkpoint: world.result.state, oracle: world.oracle }).verdict).toBe("passed");
  expect(contentHash(replaySimulationState(world.result.state).truth)).toBe(contentHash(world.result.state.truth));
});

it("rejects snapshot drift and selector misuse without changing opaque payloads", () => {
  const context = { state: { baseRevision: 1, canonicalTruth: { elapsedSeconds: 0,
    entities: { "ref:entity:player": { lifecycle: "active", placementRef: "ref:placement:road" } }, facts: {} } },
    referenceCatalog: { candidates: ["ref:entity:player", "ref:placement:road"].map((handle) => ({ handle, allowedUses: ["assertion"] })) } };
  const codec = new TransitionEvidenceCodec(context), sourceHash = contentHash(context);
  const wire = { operations: [{ kind: "place_entity", entityRef: "ref:entity:player", placementRef: "ref:placement:gate", assertions: [{ kind: "input_state_fact", key: "input_0" }] }],
    mechanicInvocations: [{ input: { literal: { kind: "operation_effect", operationIndex: 999 } }, assertions: [{ kind: "input_state_fact", key: "input_0" }] }],
    outcomes: [{ assertions: [{ kind: "operation_effect", operationIndex: 0 }] }], events: [], decisionRequests: [] };
  const decoded = codec.output(wire, context) as typeof wire;
  expect(decoded.mechanicInvocations[0]!.input).toEqual(wire.mechanicInvocations[0]!.input);
  expect(contentHash(context)).toBe(sourceHash);
  const changed = structuredClone(context);changed.state.baseRevision += 1;
  expect(() => codec.output(wire, changed)).toThrow("snapshot mismatch");
  const missing = structuredClone(wire);missing.outcomes[0]!.assertions[0]!.operationIndex = 9;
  expect(() => codec.output(missing, context)).toThrow("missing operation");
  const wrongEpoch = structuredClone(wire) as unknown as { outcomes: Array<{ assertions: unknown[] }> };
  wrongEpoch.outcomes[0]!.assertions = [{ kind: "input_state_fact", key: "input_0" }];
  expect(() => codec.output(wrongEpoch, context)).toThrow("outside preconditions");
});
