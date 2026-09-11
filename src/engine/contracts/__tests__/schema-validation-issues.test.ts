import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanDraftSchema } from "../llm-schemas";
import { schemaValidationIssues } from "../schema-validation-issues";
import { validationIssues } from "../prompts";
import { ModelOutputError } from "../../models/model-provider";

const sources = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fact"), ref: z.string() }),
  z.strictObject({ kind: z.literal("law"), ref: z.string() }),
]);
const schema = z.object({ factors: z.array(z.union([
  z.object({ source: sources, role: z.literal("control") }),
  z.object({ source: sources, role: z.literal("potency") }),
])) });

it("keeps original union failures and exposes common discriminator constraints at exact paths", () => {
  const value = { factors: [{ source: { kind: "quantity", ref: "ref:quantity:stock" }, role: "control" }] };
  const parsed = schema.safeParse(value);
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  const issues = schemaValidationIssues(parsed.error, value);
  expect(issues).toEqual([
    { code: "invalid_union", path: ["factors", 0], message: "Invalid input", originalValue: value.factors[0] },
    { code: "invalid_union_discriminator", path: ["factors", 0, "source", "kind"],
      message: 'Every schema alternative requires this discriminator to be one of "fact", "law".', originalValue: "quantity" },
  ]);
  expect(issues.some(issue => issue.path.includes("role"))).toBe(false);
  issues[0]!.originalValue = null;
  expect(value.factors[0]!.source.kind).toBe("quantity");
});

it("does not report a branch-only constraint as necessary across a union", () => {
  const result = z.union([z.object({ source: sources }), z.object({ freeText: z.string() })]).safeParse({ source: { kind: "quantity" } });
  expect(result.success).toBe(false);
  if (!result.success) {
    const issues = schemaValidationIssues(result.error);
    expect(issues[0]).toEqual({ code: "invalid_union", path: [], message: "Invalid input" });
    expect(issues.map(issue => issue.code)).toEqual(["invalid_union", "invalid_union_alternatives"]);
    expect(issues[1]!.message).toContain('"anyOf"');
    expect(issues[1]!.message).toContain('"source","kind"');
    expect(issues[1]!.message).toContain('"freeText"');
    expect(issues[1]!.message).toContain("No alternative is selected automatically");
  }
});

it("reports the explicitly selected authored branch without forcing a source or authority correction", () => {
  const factor = { authority: "authored", source: { kind: "fact", ref: "ref:fact:readiness" }, role: "control",
    direction: "hindering", steps: 1, channel: "readiness", explanation: "The crew is fatigued." };
  const value = { mode: "automatic", factors: [factor] }, before = structuredClone(value);
  const parsed = resolutionPlanDraftSchema.safeParse(value);
  if (parsed.success) throw new Error("invalid authored fact accepted");
  const issues = schemaValidationIssues(parsed.error, value);
  expect(issues).toContainEqual(expect.objectContaining({ code: "invalid_union", path: ["factors", 0, "source", "kind"], originalValue: "fact" }));
  expect(issues.some(issue => issue.code === "invalid_union_alternatives")).toBe(false);
  expect(value).toEqual(before);
  // Both legitimate semantic decisions remain expressible; diagnostics do
  // not choose between keeping this fact and choosing an authored rating.
  for (const replacement of [{ ...factor, authority: "semantic" }, { ...factor, source: { kind: "rating", ref: "ref:rating:readiness" } }]) {
    const result = resolutionPlanDraftSchema.safeParse({ ...value, factors: [replacement] });
    if (result.success) continue;
    expect(result.error.issues.some(issue => issue.path[0] === "factors")).toBe(false);
  }
});

it("uses the union of allowed discriminator values instead of choosing the narrowest branch", () => {
  const narrow = z.discriminatedUnion("kind", [z.object({ kind: z.literal("law"), ref: z.string() })]);
  const result = z.union([z.object({ source: sources }), z.object({ source: narrow })]).safeParse({ source: { kind: "quantity" } });
  expect(result.success).toBe(false);
  if (!result.success) expect(schemaValidationIssues(result.error)[1]!.message).toContain('"fact", "law"');
});

it("does not infer the absence of common non-discriminator corrections", () => {
  const result = z.object({ value: z.union([z.string(), z.number()]) }).safeParse({ value: null });
  if (result.success) throw new Error("invalid null accepted");
  const message = schemaValidationIssues(result.error)[1]!.message;
  expect(message).toContain("expected string");
  expect(message).toContain("expected number");
  expect(message).not.toContain("No single field correction");
});

it("retains the rejected value nearest to the actual schema failure through output wrappers", () => {
  const value = { factors: [{ source: { kind: "quantity", ref: "ref:quantity:stock" }, role: "control" }] };
  const result = schema.safeParse(value);
  if (result.success) throw new Error("invalid fixture");
  const inner = new ModelOutputError("rejected", undefined, { cause: result.error, rawValue: value });
  const outer = new ModelOutputError("wrapped", undefined, { cause: inner, rawValue: { unrelated: true } });
  expect(validationIssues(outer)[1]).toMatchObject({ path: ["factors", 0, "source", "kind"], originalValue: "quantity" });
  expect(schemaValidationIssues(result.error)[1]).not.toHaveProperty("originalValue");
  const unbound = new ModelOutputError("unbound", undefined, { cause: result.error });
  const misleadingOuter = new ModelOutputError("outer", undefined, { cause: unbound, rawValue: value });
  expect(validationIssues(misleadingOuter)[1]).not.toHaveProperty("originalValue");
});

it("reports the selected factor source-kind failure alongside unrelated required fields", () => {
  // Select the real automatic-plan alternative; all other mandatory fields are
  // intentionally absent so this also verifies that unrelated errors survive.
  const value = { mode: "automatic", factors: [{ authority: "semantic", source: { kind: "quantity", ref: "ref:quantity:stock" },
    role: "control", direction: "helpful", steps: 1, channel: null, explanation: "A visible stock." }] };
  const result = resolutionPlanDraftSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success) {
    const issues = schemaValidationIssues(result.error, value);
    expect(issues).toContainEqual(expect.objectContaining({ code: "invalid_union", path: ["factors", 0, "source", "kind"], originalValue: "quantity" }));
    expect(issues.length).toBe(result.error.issues.length);
  }
});
