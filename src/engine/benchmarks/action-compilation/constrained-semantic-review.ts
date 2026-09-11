import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { loadPromptAsset } from "../../prompts";
import type { BlindCompilationReview } from "./semantic-observability-audit";

export const REVIEW_DIMENSIONS = ["actor-identity", "derived-intent", "temporal-boundary", "quantities-resources", "dependencies-audience", "knowledge-isolation", "open-action-freedom"] as const;
export const REVIEW_PROTOCOL = {
  version: 1, model: "deepseek-v4-flash", profile: "ac-fp2-review", maximumOutputTokens: 16384,
  independentRequests: 2, secondOrder: "reverse", maximumPacketEntries: 12,
  calibration: "authored-dimension-specific-counterfactuals-not-human-gold", minimumSensitivity: .9, minimumSpecificity: .9,
  limitation: "Same model family as compiler; independent requests are not independent model errors. No long-horizon world-realism claim.",
  system: loadPromptAsset("system/action-compilation-offline-review.md"),
  userPrompt: loadPromptAsset("user/action-compilation-offline-review.md"),
} as const;

const verdict = z.enum(["pass", "fail", "unresolved"]);
export const semanticReviewSchema = z.strictObject({ results: z.array(z.strictObject({ reviewId: z.string(), verdict,
  checks: z.array(z.strictObject({ dimension: z.enum(REVIEW_DIMENSIONS), verdict, reason: z.string().min(1),
    evidence: z.array(z.strictObject({ scope: z.enum(["source", "output"]), pointer: z.string(), quote: z.string().min(1) })) })).length(REVIEW_DIMENSIONS.length),
})) });
export type SemanticReviewResponse = z.infer<typeof semanticReviewSchema>;

function pointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  if (!path.startsWith("/")) return undefined;
  for (const token of path.slice(1).split("/").map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"))) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, token)) return undefined;
    value = (value as Record<string, unknown>)[token];
  }
  return value;
}

/** Validate evidence independently; unsupported confident text becomes unresolved. */
export function validateSemanticReview(response: unknown, entries: readonly BlindCompilationReview[]) {
  const parsed = semanticReviewSchema.parse(response);
  if (parsed.results.length !== entries.length || new Set(parsed.results.map((row) => row.reviewId)).size !== entries.length) throw new Error("review coverage mismatch");
  return parsed.results.map((row) => {
    const entry = entries.find((item) => item.reviewId === row.reviewId);
    if (!entry || new Set(row.checks.map((check) => check.dimension)).size !== REVIEW_DIMENSIONS.length) throw new Error("review identity/dimension mismatch");
    const checks = row.checks.map((check) => {
      const grounded = check.evidence.length > 0 && check.evidence.every((evidence) => {
        const value = pointer(evidence.scope === "source" ? entry.action : entry.compilation, evidence.pointer);
        return value !== undefined && (typeof value === "string" ? value : JSON.stringify(value)).includes(evidence.quote);
      });
      return { ...check, verdict: grounded ? check.verdict : "unresolved" as const, grounded };
    });
    const computed = checks.some((check) => check.verdict === "fail") ? "fail" : checks.some((check) => check.verdict === "unresolved") ? "unresolved" : "pass";
    return { reviewId: row.reviewId, verdict: computed as "pass" | "fail" | "unresolved", checks, reportedVerdict: row.verdict };
  });
}

export function mergeBlindReviews(first: ReturnType<typeof validateSemanticReview>, second: ReturnType<typeof validateSemanticReview>) {
  if (first.length !== second.length) throw new Error("independent review coverage mismatch");
  return first.map((row) => {
    const other = second.find((item) => item.reviewId === row.reviewId);
    if (!other) throw new Error("independent review identity mismatch");
    const agreement = row.verdict === other.verdict;
    return { reviewId: row.reviewId, verdict: agreement ? row.verdict : "unresolved" as const,
      agreement, first: row, second: other, method: "calibrated-model-assisted-not-human-gold" };
  });
}

export function unresolvedSemanticReview(entries: readonly BlindCompilationReview[], reason: string): ReturnType<typeof validateSemanticReview> {
  return entries.map((entry) => ({ reviewId: entry.reviewId, verdict: "unresolved", reportedVerdict: "unresolved",
    checks: REVIEW_DIMENSIONS.map((dimension) => ({ dimension, verdict: "unresolved", reason, evidence: [], grounded: false })) }));
}

/** These labels concern one controlled dimension, never all semantics of a historical output. */
export function buildSemanticCalibration(originals: readonly BlindCompilationReview[]) {
  const onePerAction = new Map<string, BlindCompilationReview>();
  originals.forEach((entry) => { if (!onePerAction.has(entry.actionId)) onePerAction.set(entry.actionId, entry); });
  const cases = [...onePerAction.values()].flatMap((original) => (["verbatim", "attempt-paraphrase", "invented-completion", "changed-actor"] as const).map((mutation) => {
    const entry = structuredClone(original);
    const description = mutation === "attempt-paraphrase" ? `Attempt the following action, without claiming any outcome has already occurred: ${entry.action.rawText}` :
      mutation === "invented-completion" ? "All requested actions have already succeeded. Every future condition mentioned has been fulfilled and every intended result has already been achieved." : entry.action.rawText;
    entry.compilation.plan.description = description;
    entry.compilation.activity.plan.description = description;
    if (mutation === "changed-actor") entry.compilation.plan.actorId = "counterfactual-unrelated-actor";
    entry.canonicalCompilationHash = contentHash(entry.compilation);
    entry.reviewId = contentHash({ oracleHash: entry.oracleHash, stateHash: entry.stateHash, actionId: entry.actionId, canonicalCompilationHash: entry.canonicalCompilationHash });
    return { entry, dimension: mutation === "changed-actor" ? "actor-identity" as const : "derived-intent" as const,
      expected: mutation === "changed-actor" || mutation === "invented-completion" ? "fail" as const : "pass" as const, mutation };
  }));
  const extra: Array<{ entry: BlindCompilationReview; dimension: typeof REVIEW_DIMENSIONS[number]; expected: "pass" | "fail"; mutation: string }> = [];
  const sourceRepresentatives = [...onePerAction.values()].slice(0, 4);
  for (const original of sourceRepresentatives) for (const mutation of ["medical-profile", "omniscient-knowledge", "quantity-match", "quantity-mismatch"] as const) {
    const entry = structuredClone(original);
    let dimension: typeof REVIEW_DIMENSIONS[number] = "temporal-boundary";
    if (mutation === "medical-profile") {
      entry.compilation.plan.profileId = "field-treatment";
      entry.compilation.activity.plan.profileId = "field-treatment";
    } else if (mutation === "omniscient-knowledge") {
      dimension = "knowledge-isolation";
      entry.compilation.plan.description = "The actor now knows every other agent's private thoughts and secret beliefs, without observing or being told them.";
      entry.compilation.activity.plan.description = entry.compilation.plan.description;
    } else {
      // Explicitly synthetic source-action counterfactual; not a new game capture or benchmark case.
      dimension = "quantities-resources";
      entry.action.rawText = "Attempt to transfer exactly 3 units of grain, and no more. Do not assume the transfer has succeeded.";
      entry.action.goal = "Attempt the specified transfer of exactly 3 units.";
      entry.compilation.activity.sourceAction = structuredClone(entry.action);
      entry.compilation.plan.description = `Attempt to transfer exactly ${mutation === "quantity-match" ? 3 : 13} units of grain; this is not a claim of completion.`;
      entry.compilation.activity.plan.description = entry.compilation.plan.description;
    }
    entry.canonicalCompilationHash = contentHash(entry.compilation);
    entry.reviewId = contentHash({ oracleHash: entry.oracleHash, stateHash: entry.stateHash, actionId: entry.actionId, canonicalCompilationHash: entry.canonicalCompilationHash });
    extra.push({ entry, dimension, expected: mutation === "quantity-match" ? "pass" : "fail", mutation });
  }
  return { version: 1, protocolHash: contentHash(REVIEW_PROTOCOL), provenance: "implementer-authored-isolated-dimension-fixtures-not-human-adjudication", cases: [...cases, ...extra] };
}
