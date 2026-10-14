import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CONTINUITY_CASES, CONTINUITY_FAMILIES, CONTINUITY_SEEDS, RECOVERY_BOUNDARIES } from "../cases";

describe("frozen conversational evaluation design", () => {
  it("pins the pre-implementation corpus independently of runtime and prompt revisions", () => {
    expect(createHash("sha256").update(readFileSync(new URL("../cases.ts", import.meta.url))).digest("hex"))
      .toBe("3ecc09d73544b07f85b1f8658e360c4441c94371cf9cc2261cffe37eb65c7744");
  });
  it("contains complete continuous flows in both worlds with no duplicate identifiers or empty expectations", () => {
    expect(new Set(CONTINUITY_CASES.map(item => item.id)).size).toBe(22);
    for (const phase of ["development", "confirmation", "continuous"] as const) {
      const cases = CONTINUITY_CASES.filter(item => item.phase === phase);
      expect(cases).toHaveLength({ development: 8, confirmation: 12, continuous: 2 }[phase]);
      for (const world of ["blackmarsh", "station-program-world"]) {
        expect(cases.filter(item => item.world === world)).toHaveLength(cases.length / 2);
      }
      for (const item of cases) {
        expect(item.turns).toHaveLength(phase === "continuous" ? 12 : 6);
        for (const turn of item.turns) {
          expect(turn.text.trim().length).toBeGreaterThan(2);
          expect(turn.expectation.trim().length).toBeGreaterThan(6);
        }
      }
    }
    expect(CONTINUITY_CASES.flatMap(item => item.turns)).toHaveLength(144);
  });

  it("covers all semantic families in confirmation without including expectations in player input", () => {
    const cases = CONTINUITY_CASES.filter(item => item.phase === "confirmation");
    expect(new Set(cases.flatMap(item => item.families))).toEqual(new Set(CONTINUITY_FAMILIES));
    expect(CONTINUITY_SEEDS).toEqual([20261014, 20261015]);
    expect(RECOVERY_BOUNDARIES).toHaveLength(12);
    for (const { turns } of cases) for (const { text } of turns) {
      expect(text).not.toMatch(/(?:断言|schema|submissionId|assert|grounded|confirmation)/u);
    }
  });
});
