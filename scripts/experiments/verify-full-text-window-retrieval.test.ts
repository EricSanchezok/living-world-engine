import { expect, it } from "vitest";
import { fullTextRetrievalConsistent } from "./verify-full-text-window-retrieval";

it("requires complete passage and action cohorts, actual partial population and exact native consistency", () => {
  const passages = [{ worldHash: "B", count: 100, maxDelta: 0 }, { worldHash: "C", count: 101, maxDelta: 0 }];
  const rows = [12, 12, 12, 5, 8].map((actionCount, index) => ({ index, actionCount, matchesFrozenQuery: true,
    partialMatchesCold: true, warmMatchesCold: true, regeneratedMatchesCold: true, partialHits: 3, partialMisses: 2, warmMisses: 0, passageMisses: 0 }));
  expect(fullTextRetrievalConsistent(passages, rows, 8)).toBe(true);
  expect(fullTextRetrievalConsistent(passages, rows.slice(0, 4), 8)).toBe(false);
  expect(fullTextRetrievalConsistent(passages, rows, 0)).toBe(false);
  expect(fullTextRetrievalConsistent([passages[0]!, { ...passages[1]!, maxDelta: 1e-9 }], rows, 8)).toBe(false);
  for (const change of [{ matchesFrozenQuery: false }, { regeneratedMatchesCold: false }, { partialMatchesCold: false },
    { warmMatchesCold: false }, { partialMisses: 0 }, { warmMisses: 1 }, { passageMisses: 1 }, { actionCount: 11 }]) {
    expect(fullTextRetrievalConsistent(passages, [{ ...rows[0]!, ...change }, ...rows.slice(1)], 8)).toBe(false);
  }
});
