import { expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { compactTransitionAssertionSchema, expandTransitionAssertionReferences } from "../transition-schema-references";

it("factors only identical schema positions and restores the exact constraints without editing literal data", () => {
  const assertion = { type: "object", properties: { kind: { const: "fact_matches" } }, required: ["kind"], additionalProperties: false };
  const source = { type: "object", properties: { outcomes: { type: "array", items: { type: "object", properties: {
    firstAssertion: assertion, additionalAssertions: { type: "array", items: assertion },
    literal: { const: assertion, enum: [assertion], default: assertion, examples: [assertion] },
  }, required: ["firstAssertion", "additionalAssertions"], additionalProperties: false } } }, required: ["outcomes"], additionalProperties: false };
  const before = contentHash(source), compact = compactTransitionAssertionSchema(source);
  expect(contentHash(source)).toBe(before);
  expect(expandTransitionAssertionReferences(compact)).toEqual(source);
  expect(JSON.stringify(compact)).toContain('"$ref":"#/definitions/causalAssertion"');
  expect(() => compactTransitionAssertionSchema(compact)).toThrow("contract changed");
  const changed = structuredClone(compact);
  changed.definitions = { causalAssertion: null };
  expect(() => expandTransitionAssertionReferences(changed)).toThrow("contract changed");
  const siblings = { definitions: compact.definitions, properties: { value: { $ref: "#/definitions/causalAssertion", type: "string" } } };
  expect(() => expandTransitionAssertionReferences(siblings)).toThrow("contract changed");
  const recursive = { ...source, definitions: { originalJson: { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/definitions/originalJson" } }] } } };
  const withDefinitions = compactTransitionAssertionSchema(recursive);
  expect((withDefinitions.definitions as Record<string, unknown>).originalJson).toEqual(recursive.definitions.originalJson);
  expect(expandTransitionAssertionReferences(withDefinitions)).toEqual(recursive);
});
