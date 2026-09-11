import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import type { AgentActionProposal } from "../../contracts/model";

const reviewSchema = z.strictObject({
  method: z.literal("source-bound-assistant-review"), step: z.number().int().positive(),
  sourceStateHash: z.string().length(64), checkpointStateHash: z.string().length(64),
  cases: z.array(z.strictObject({ actionId: z.string(), actionHash: z.string().length(64), verdict: z.enum(["pass", "fail", "unknown"]),
    reason: z.string().min(20), evidencePaths: z.array(z.string().startsWith("/")).min(1) })),
});

/** A source-bound review may veto a commit; this is not a calibrated judge. */
export function assertTrajectorySourceReview(value: unknown, binding: { step: number; sourceStateHash: string; checkpointStateHash: string; actions: readonly AgentActionProposal[]; evidence: Record<string, unknown> }) {
  const review = reviewSchema.parse(value);
  if (review.step !== binding.step || review.sourceStateHash !== binding.sourceStateHash || review.checkpointStateHash !== binding.checkpointStateHash) throw new Error("trajectory review snapshot mismatch");
  if (review.cases.length !== binding.actions.length || new Set(review.cases.map((entry) => entry.actionId)).size !== binding.actions.length) throw new Error("trajectory review action coverage mismatch");
  for (const entry of review.cases) {
    const action = binding.actions.find((item) => item.id === entry.actionId);
    if (!action || contentHash(action) !== entry.actionHash) throw new Error("trajectory review action binding mismatch");
    for (const pointer of entry.evidencePaths) {
      let node: unknown = binding.evidence;
      for (const key of pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) throw new Error("trajectory review evidence path missing");
        node = (node as Record<string, unknown>)[key];
      }
    }
    if (entry.verdict !== "pass") throw new Error(`trajectory source semantics ${entry.verdict}: ${entry.actionId}: ${entry.reason}`);
  }
  return review;
}
