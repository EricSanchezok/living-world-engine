import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { parseWorldTemplate } from "../../src/script/world-loader";

const sourceRefSchema = z.strictObject({ chapterId: z.string(), chapterSha256: z.string(), start: z.number().int().nonnegative(),
  end: z.number().int().positive(), anchorSha256: z.string() });
export const authoredClaimSchema = z.strictObject({
  id: z.string().min(1), statement: z.string().min(1),
  classification: z.enum(["canon", "testimony", "backprojection", "original", "calibration"]),
  validAtOpening: z.boolean(), learnedTime: z.string(), openingReason: z.string().min(1),
  status: z.enum(["reviewed-for-sample", "reviewed", "pending"]),
  dependencies: z.array(z.string()), evidence: z.array(sourceRefSchema),
});
export type AuthoredClaim = z.infer<typeof authoredClaimSchema>;
export const authoredModuleSchema = z.strictObject({
  id: z.string(), scope: z.enum(["sample", "full"]), template: z.unknown(),
  provenance: z.record(z.string(), z.array(z.string()).min(1)),
});
export const moduleApprovalSchema = z.strictObject({
  moduleHash: z.string(), claimsHash: z.string(), reviewer: z.string().min(1),
  scope: z.enum(["sample", "full"]), limitations: z.array(z.string()),
});

export function assertFullCoverage(coverage: {
  inventory_sealed: boolean; domains: Array<{ modules: Array<{ status: string }>; status: string }>;
  origins: Array<{ status: string }>;
}, chapters: Array<{ acquired: boolean; read: boolean; extracted: boolean; reviewed: boolean }>, unresolvedSourceIssues: number) {
  if (!coverage.inventory_sealed || unresolvedSourceIssues || !chapters.length ||
    chapters.some(chapter => !chapter.acquired || !chapter.read || !chapter.extracted || !chapter.reviewed) ||
    !coverage.domains.length || coverage.domains.some(domain => domain.status !== "complete" || !domain.modules.length || domain.modules.some(bundle => bundle.status !== "complete")) ||
    coverage.origins.length !== 9 || coverage.origins.some(origin => origin.status !== "complete")) {
    throw new Error("full-world coverage is incomplete; sample qualification cannot release the full world");
  }
}

/** Deterministic compilation requires pinned editorial approval, not model-generated completion flags. */
export function compileAuthoredModule(input: unknown, claimInput: unknown[], approvalInput: unknown,
  readChapter: (id: string) => string, blockedChapters: Set<string> = new Set()) {
  const bundle = authoredModuleSchema.parse(input), approval = moduleApprovalSchema.parse(approvalInput);
  const claims = z.array(authoredClaimSchema).parse(claimInput);
  if (approval.moduleHash !== contentHash(bundle) || approval.claimsHash !== contentHash(claims) || approval.scope !== bundle.scope) {
    throw new Error("authoring bundle or claims changed after review");
  }
  const byId = new Map(claims.map(claim => [claim.id, claim]));
  if (byId.size !== claims.length) throw new Error("duplicate authored claim id");
  const checked = new Set<string>(), visiting = new Set<string>();
  function checkClaim(id: string): void {
    if (checked.has(id)) return;
    if (visiting.has(id)) throw new Error(`cyclic claim dependency ${id}`);
    const claim = byId.get(id);
    if (!claim || claim.status === "pending" || !claim.validAtOpening || (bundle.scope === "full" && claim.status !== "reviewed")) {
      throw new Error(`unreviewed, missing or post-opening claim ${id}`);
    }
    if (!["original", "calibration"].includes(claim.classification) && !claim.evidence.length) throw new Error(`missing source evidence ${id}`);
    visiting.add(id);
    for (const dependency of claim.dependencies) checkClaim(dependency);
    for (const ref of claim.evidence) {
      if (blockedChapters.has(ref.chapterId)) throw new Error(`unresolved source integrity ${ref.chapterId}`);
      const source = readChapter(ref.chapterId), chars = [...source];
      if (contentHash(source) !== ref.chapterSha256 || ref.start >= ref.end || ref.end > chars.length ||
        contentHash(chars.slice(ref.start, ref.end).join("")) !== ref.anchorSha256) throw new Error(`source reference drift ${id}`);
    }
    visiting.delete(id); checked.add(id);
  }
  const template = parseWorldTemplate(bundle.template);
  const required = ["manifest", "mechanics", ...template.laws.laws.map(law => `law:${law.id}`),
    ...template.entities.map(entity => `entity:${entity.id}`),
    ...(template.participation?.origins ?? []).map(origin => `origin:${origin.id}`)];
  for (const key of required) {
    if (!bundle.provenance[key]?.length) throw new Error(`missing provenance for ${key}`);
  }
  const factTargets = template.entities.flatMap(entity => entity.facts.map(fact => `fact:${fact.id}`));
  if (bundle.scope === "full") for (const key of factTargets) {
    if (!bundle.provenance[key]?.length) throw new Error(`missing provenance for ${key}`);
  }
  for (const [key, references] of Object.entries(bundle.provenance)) {
    if (!required.includes(key) && !factTargets.includes(key)) throw new Error(`stale provenance target ${key}`);
    for (const id of references) checkClaim(id);
  }
  return { template, receipt: { moduleId: bundle.id, scope: bundle.scope, moduleHash: approval.moduleHash,
    claimsHash: approval.claimsHash, usedClaimIds: [...checked].sort(), provenance: bundle.provenance,
    limitations: approval.limitations } };
}
