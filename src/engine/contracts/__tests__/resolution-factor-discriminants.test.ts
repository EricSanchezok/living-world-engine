import { expect, it } from "vitest";
import { z } from "zod";
import { modelResolutionFactorSchema } from "../llm-schemas";
import { schemaValidationIssues } from "../schema-validation-issues";

// The unselected union is the original validation contract over the same
// strict alternatives; compare accepted values, not model self-reports.
const unselected = z.union(modelResolutionFactorSchema.options.map(branch => z.union(branch.options)));
const factor = { authority: "semantic", role: "control", source: { kind: "fact", ref: "ref:fact:policy" },
  direction: "helpful", steps: 1, channel: null, explanation: "The stated policy supports this choice." };

it("preserves the factor domain across valid choices, malformed fields and explicit discriminator changes", () => {
  let accepted = 0, rejected = 0;
  for (const authority of ["semantic", "authored", "invented", null]) {
    for (const role of ["permission", "secondary", "risk", "control", "potency", "protection", "invented", null]) {
      for (const kind of ["action", "entity", "fact", "placement", "condition", "rating", "law", "quantity"]) {
        for (const direction of ["neutral", "helpful", "hindering", undefined]) for (const steps of [0, 1, 2]) {
          for (const channel of [null, "escort"]) {
            const value = { ...factor, authority, role, source: { kind, ref: `ref:${kind}:source` }, direction, steps, channel };
            const old = unselected.safeParse(value), current = modelResolutionFactorSchema.safeParse(value);
            expect(current.success).toBe(old.success);
            if (old.success && current.success) { accepted++; expect(current.data).toEqual(old.data); } else rejected++;
          }
        }
      }
    }
  }
  for (const key of Object.keys(factor)) {
    const value: Record<string, unknown> = { ...factor }; delete value[key];
    expect(modelResolutionFactorSchema.safeParse(value).success).toBe(unselected.safeParse(value).success);
  }
  expect(modelResolutionFactorSchema.safeParse({ ...factor, unexpected: true }).success).toBe(false);
  expect(accepted).toBeGreaterThan(100); expect(rejected).toBeGreaterThan(1000);
});

it("reports the two omitted directions in the declared factor branches without changing either choice", () => {
  const value = { factors: [
    { ...factor, direction: undefined },
    { ...factor, role: "potency", channel: "escort", direction: undefined },
  ] };
  const before = structuredClone(value), schema = z.object({ factors: z.array(modelResolutionFactorSchema) });
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error("missing directions accepted");
  const issues = schemaValidationIssues(parsed.error, value);
  expect(issues.map(issue => issue.path)).toEqual([["factors", 0, "direction"], ["factors", 1, "direction"]]);
  expect(issues.every(issue => issue.message.includes("helpful") && issue.message.includes("hindering"))).toBe(true);
  expect(issues.some(issue => issue.code === "invalid_union_alternatives")).toBe(false);
  expect(value).toEqual(before);
  for (const direction of ["helpful", "hindering"]) expect(schema.safeParse({ factors: value.factors.map(row => ({ ...row, direction })) }).success).toBe(true);
});

it("keeps both source and authority corrections expressible for an authored fact mismatch", () => {
  const value = { ...factor, authority: "authored" };
  const result = modelResolutionFactorSchema.safeParse(value);
  if (result.success) throw new Error("authored fact accepted");
  expect(result.error.issues[0]?.path).toEqual(["source", "kind"]);
  expect(modelResolutionFactorSchema.safeParse({ ...value, authority: "semantic" }).success).toBe(true);
  expect(modelResolutionFactorSchema.safeParse({ ...value, source: { kind: "rating", ref: "ref:rating:escort" } }).success).toBe(true);
  expect(value.authority).toBe("authored");
});
