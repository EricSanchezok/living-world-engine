import { describe, expect, it } from "vitest";
import { REVIEW_DIMENSIONS, mergeBlindReviews, validateSemanticReview } from "./constrained-semantic-review";
import type { BlindCompilationReview } from "./semantic-observability-audit";
const entry = { reviewId: "one", action: { rawText: "Try opening the gate" }, compilation: { plan: { description: "Attempt to open the gate" } } } as BlindCompilationReview;
function response() { return { results: [{ reviewId: "one", verdict: "pass", checks: REVIEW_DIMENSIONS.map((dimension) => ({ dimension,
  verdict: "pass", reason: "supported", evidence: [{ scope: "source", pointer: "/rawText", quote: "Try opening" }] })) }] }; }
describe("blinded review evidence guardrails", () => {
  it("cannot turn fabricated evidence into semantic success", () => {
    const raw = response();
    raw.results[0]!.checks[0]!.evidence[0]!.quote = "The gate has opened";
    const validated = validateSemanticReview(raw, [entry]);
    expect(validated[0]!.verdict).toBe("unresolved");
    expect(validated[0]!.checks[0]!.grounded).toBe(false);
  });
  it("requires exact coverage, distinct dimensions, and independent agreement", () => {
    expect(() => validateSemanticReview({ results: [] }, [entry])).toThrow("coverage");
    const duplicate = response();
    duplicate.results[0]!.checks[1]!.dimension = duplicate.results[0]!.checks[0]!.dimension;
    expect(() => validateSemanticReview(duplicate, [entry])).toThrow("dimension");
    const pass = validateSemanticReview(response(), [entry]);
    const other = response(); other.results[0]!.checks[0]!.verdict = "fail";
    const failed = validateSemanticReview(other, [entry]);
    expect(mergeBlindReviews(pass, failed)[0]!.verdict).toBe("unresolved");
  });
});
