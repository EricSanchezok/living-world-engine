import { expect, it } from "vitest";
import { z } from "zod";
import { cacheNamespaceRequest, statePrefixDecision } from "./step-state-prefix-probe";

it("requires complete paired candidate admission without lost initial actions or additional cost", () => {
  const rows: Parameters<typeof statePrefixDecision>[0] = ["016", "017"].flatMap(rootId => [
    { rootId, arm: "B", complete: false, initialAdmittedActions: 4, httpCalls: 3, totalTokens: 1000, documentedKnownNanoCny: 1000 },
    { rootId, arm: "L", complete: true, initialAdmittedActions: 5, httpCalls: 2, totalTokens: 900, documentedKnownNanoCny: 800 },
  ]);
  const changed = (values: Partial<(typeof rows)[number]>) => rows.map((row, index) => index === 1 ? { ...row, ...values } : row);
  expect(statePrefixDecision(rows, false)).toBe("eligible-for-source-semantic-review");
  expect(statePrefixDecision(changed({ complete: false }), false)).toBe("failed");
  expect(statePrefixDecision(changed({ initialAdmittedActions: 0 }), false)).toBe("failed");
  expect(statePrefixDecision(changed({ totalTokens: 1101 }), false)).toBe("failed");
  expect(statePrefixDecision(changed({ httpCalls: 5 }), false)).toBe("failed");
  expect(statePrefixDecision(changed({ documentedKnownNanoCny: 1201 }), false)).toBe("failed");
  expect(statePrefixDecision(changed({ documentedKnownNanoCny: null }), false)).toBe("inconclusive");
  expect(statePrefixDecision(changed({ rootId: "017" }), false)).toBe("inconclusive");
  expect(statePrefixDecision(rows.slice(1), false)).toBe("inconclusive");
  expect(statePrefixDecision(rows, true)).toBe("inconclusive");
});

it("adds one common namespace without changing context, schema, settings, or original instructions", () => {
  const request = { workloadId: "world", batchId: "batch", role: "truth-resolution" as const, profileId: "flash", subjectId: "batch", promptVersion: "v1", schemaName: "plan",
    system: "original system", userPrompt: "original task", context: { fullSource: [1, 2, 3] }, schema: z.object({}) };
  const id = "a".repeat(64), value = cacheNamespaceRequest(request, id);
  expect(value.system.endsWith(`\n\n${request.system}`)).toBe(true);
  expect(value.system).toContain(id);
  expect(value.promptVersion).toBe(`v1/cache-namespace-${id}`);
  expect({ ...value, system: request.system, promptVersion: request.promptVersion }).toEqual(request);
  expect(value.context).toBe(request.context);
  expect(value.schema).toBe(request.schema);
  expect(request.system).toBe("original system");
  expect(() => cacheNamespaceRequest(value, id)).toThrow("repeated");
  expect(() => cacheNamespaceRequest(request, "not-a-frozen-id")).toThrow("invalid");
});
