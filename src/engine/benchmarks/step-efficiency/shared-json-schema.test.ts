import { expect, it } from "vitest";
import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { replaySimulationState } from "../../runtime/transaction";
import { evaluateCommittedBehaviorOracle } from "./behavior-oracle";
import { runConditionalCompletionScenario } from "./conditional-scenario";
import { expandSharedJsonSchema, factorSharedJsonSchema, sharedSchemaRequest } from "./shared-json-schema";

it.each(["continuing", "arrived", "invalid"] as const)("roundtrips the full %s schema and preserves real execution inputs", async (scenario) => {
  const world = await runConditionalCompletionScenario(scenario, async (request, fallback) => {
    const base = request, candidate = sharedSchemaRequest(base);
    const proof = factorSharedJsonSchema(base.wireJsonSchema ?? z.toJSONSchema(base.schema, { target: "draft-07" }));
    expect(proof.sourceHash).toBe(proof.restoredHash);
    expect(proof.wireBytes).toBeLessThan(proof.originalBytes * 0.5);
    expect(candidate.context).toBe(base.context);
    expect(candidate.schema).toBe(base.schema);
    expect(candidate.preprocessOutput).toBe(base.preprocessOutput);
    expect(candidate.system).toBe(base.system);
    expect(candidate.userPrompt).toBe(base.userPrompt);
    return fallback();
  }, true);
  expect(evaluateCommittedBehaviorOracle({ source: world.source, action: world.action, checkpoint: world.result.state, oracle: world.oracle }).verdict).toBe("passed");
  expect(contentHash(replaySimulationState(world.result.state).truth)).toBe(contentHash(world.result.state.truth));
});

it("does not rewrite data objects, original recursive refs or schema scope", () => {
  const repeated = z.toJSONSchema(z.object({ values: z.array(z.string()), detail: z.string().describe("x".repeat(600)) }), { target: "draft-07" });
  const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: repeated, b: repeated,
    c: { $ref: "#/definitions/tree" }, literal: { const: repeated } }, definitions: { tree: { type: "array", items: { $ref: "#/definitions/tree" } } },
    dependencies: { a: ["b"] }, additionalProperties: false };
  const proof = factorSharedJsonSchema(schema);
  expect(expandSharedJsonSchema(proof.schema, proof.generatedNames, proof.hadDefinitions)).toEqual(schema);
  expect(JSON.stringify(proof.schema)).toContain(JSON.stringify({ const: repeated }));
  expect(() => factorSharedJsonSchema({ ...schema, $id: "relative" })).toThrow("scope");
  expect(() => factorSharedJsonSchema({ ...schema, properties: { ...schema.properties, bad: { $ref: "#/properties/a/properties/values" } } })).toThrow("direct existing root definition");
  const broken = structuredClone(proof.schema), definitions = broken.definitions as Record<string, unknown>;
  definitions[proof.generatedNames[0]!] = { $ref: `#/definitions/${proof.generatedNames[0]}` };
  expect(() => expandSharedJsonSchema(broken, proof.generatedNames, proof.hadDefinitions)).toThrow("cyclic");
});
