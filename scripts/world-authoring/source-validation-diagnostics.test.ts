import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sourceValidationDiagnostics } from "./source-validation-diagnostics";

describe("source validation diagnostics", () => {
  it("identifies the actual invalid paragraph without repeating the complete enum", () => {
    const ids = Array.from({ length: 500 }, (_, index) => `qq-123:${index * 100}`);
    const schema = z.object({ records: z.array(z.object({ paragraphId: z.enum(ids as [string, ...string[]]) })) });
    const draft = { records: [{ paragraphId: "qq-123:101" }] };
    const result = schema.safeParse(draft);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("invalid fixture");
    const diagnostics = sourceValidationDiagnostics(result.error, draft);
    expect(JSON.parse(diagnostics)).toEqual([expect.objectContaining({
      path: "records.0.paragraphId", code: "invalid_value", received: '"qq-123:101"', allowedValueCount: 500,
    })]);
    expect(diagnostics).not.toContain("qq-123:49900");
    expect(diagnostics.length).toBeLessThan(600);
    expect(schema.safeParse(draft).success).toBe(false);
  });

  it("preserves every error path and missing-field diagnostics", () => {
    const result = z.object({ id: z.string(), records: z.array(z.number()) }).safeParse({ records: ["wrong"] });
    if (result.success) throw new Error("invalid fixture");
    const rows = JSON.parse(sourceValidationDiagnostics(result.error, { records: ["wrong"] }));
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(expect.objectContaining({ path: "id", received: "<missing>" }));
    expect(rows).toContainEqual(expect.objectContaining({ path: "records.0", received: '"wrong"' }));
    expect(sourceValidationDiagnostics(new Error("missing fact IDs: fact-2"), {})).toBe("missing fact IDs: fact-2");
  });
});
