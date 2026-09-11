import { expect, it } from "vitest";
import { catalogOrderDecision } from "./step-catalog-order-probe";

it("requires both complete candidate roots and measured savings without missing or duplicate pairs", () => {
  const rows: Parameters<typeof catalogOrderDecision>[0] = ["016", "017"].flatMap(rootId => [
    { rootId, arm: "B", firstHttpComplete: false, httpCalls: 1, totalTokens: 1000 },
    { rootId, arm: "D", firstHttpComplete: true, httpCalls: 1, totalTokens: 800 },
  ]);
  expect(catalogOrderDecision(rows, false)).toBe("eligible-for-source-semantic-review");
  const altered = (change: Partial<(typeof rows)[number]>) => rows.map((row, index) => index === 1 ? { ...row, ...change } : row);
  expect(catalogOrderDecision(altered({ totalTokens: 801 }), false)).toBe("failed");
  expect(catalogOrderDecision(altered({ firstHttpComplete: false, totalTokens: 10 }), false)).toBe("failed");
  expect(catalogOrderDecision(altered({ totalTokens: null }), false)).toBe("inconclusive");
  expect(catalogOrderDecision(altered({ httpCalls: 2 }), false)).toBe("inconclusive");
  expect(catalogOrderDecision(altered({ rootId: "017" }), false)).toBe("inconclusive");
  expect(catalogOrderDecision(rows.slice(1), false)).toBe("inconclusive");
  expect(catalogOrderDecision(rows, true)).toBe("inconclusive");
  expect(catalogOrderDecision(rows.map(row => ({ ...row, firstHttpComplete: true })), false)).toBe("eligible-for-source-semantic-review");
});
