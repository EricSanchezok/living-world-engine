import { describe, expect, it } from "vitest";
import { z } from "zod";
import { constrainedNativeSchema } from "./constrained-native-schema";

describe("native tagged union lowering", () => {
  it("preserves disjoint union acceptance without mutating the canonical schema", () => {
    const schema: Record<string, unknown> = { oneOf: ["text", "number"].map((kind) => ({ type: "object", required: ["kind", "value"],
      properties: { kind: { type: "string", const: kind }, value: { type: kind === "text" ? "string" : "number" } }, additionalProperties: false })) };
    const native = constrainedNativeSchema(schema);
    const original = z.fromJSONSchema(schema), lowered = z.fromJSONSchema(native);
    for (const value of [{ kind: "text", value: "free text" }, { kind: "number", value: 3 }, { kind: "number", value: "3" }, {}, null, { kind: "text", value: "x", extra: true }]) {
      expect(lowered.safeParse(value).success).toBe(original.safeParse(value).success);
    }
    expect(native).toHaveProperty("anyOf");
    expect(schema).toHaveProperty("oneOf");
  });
  it("rejects overlapping unions rather than silently weakening validation", () => {
    expect(() => constrainedNativeSchema({ oneOf: [{ type: "number" }, { type: "integer" }] })).toThrow(/disjoint/);
  });
  it("flattens union branches and expands only scalar enum references at the union boundary", () => {
    const schema: Record<string, unknown> = { $schema: "http://json-schema.org/draft-07/schema#", definitions: { keys: { type: "string", enum: ["a", "b"] } },
      type: "object", properties: { value: { anyOf: [{ anyOf: [{ $ref: "#/definitions/keys" }, { type: "null" }] }, { type: "number" }] } } };
    const native = constrainedNativeSchema(schema);
    expect((native.properties as Record<string, { anyOf: unknown[] }>).value!.anyOf).toEqual([{ type: "string", enum: ["a", "b"] }, { type: "null" }, { type: "number" }]);
    const original = z.fromJSONSchema(schema), lowered = z.fromJSONSchema(native);
    for (const value of ["a", "b", "c", null, 3, true, {}, []]) expect(lowered.safeParse({ value }).success).toBe(original.safeParse({ value }).success);
  });
});
