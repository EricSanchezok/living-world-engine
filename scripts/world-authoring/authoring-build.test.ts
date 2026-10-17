import { describe, expect, it } from "vitest";
import path from "node:path";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadWorldTemplate } from "../../src/script/world-loader";
import { assertFullCoverage, compileAuthoredModule, type AuthoredClaim } from "./authoring-build";

const chapter = "此处在开篇以前已经建立。";
function fixture() {
  const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  const claim: AuthoredClaim = { id: "opening", statement: "场所已经存在。", classification: "canon", validAtOpening: true,
    learnedTime: "后文", openingReason: "明确说明开篇前已成立。", status: "reviewed-for-sample", dependencies: [],
    evidence: [{ chapterId: "one", chapterSha256: contentHash(chapter), start: 0, end: 4, anchorSha256: contentHash(chapter.slice(0, 4)) }] };
  const keys = ["manifest", "mechanics", ...template.laws.laws.map(law => `law:${law.id}`),
    ...template.entities.map(entity => `entity:${entity.id}`), ...template.participation!.origins.map(origin => `origin:${origin.id}`)];
  const bundle = { id: "test", scope: "sample", template, provenance: Object.fromEntries(keys.map(key => [key, [claim.id]])) };
  const claims = [claim];
  const approval = () => ({ moduleHash: contentHash(bundle), claimsHash: contentHash(claims), reviewer: "source review", scope: "sample", limitations: ["局部样本"] });
  return { bundle, claims, approval };
}

describe("authored world build gates", () => {
  it("retains a traceable sample receipt", () => {
    const f = fixture();
    expect(compileAuthoredModule(f.bundle, f.claims, f.approval(), () => chapter).receipt.usedClaimIds).toEqual(["opening"]);
  });
  it.each(["future", "unreviewed", "unknown", "cycle", "dependency", "source", "blocked", "evidence", "provenance", "changed"])("blocks %s content", kind => {
    const f = fixture(), approval = f.approval();
    if (kind === "future") f.claims[0]!.validAtOpening = false;
    if (kind === "unreviewed") f.claims[0]!.status = "pending";
    if (kind === "unknown") f.claims[0]!.dependencies = ["absent"];
    if (kind === "cycle") f.claims[0]!.dependencies = ["opening"];
    if (kind === "dependency") { f.claims.push({ ...f.claims[0]!, id: "future", validAtOpening: false }); f.claims[0]!.dependencies = ["future"]; }
    if (kind === "evidence") f.claims[0]!.evidence = [];
    if (kind === "provenance") delete f.bundle.provenance.mechanics;
    if (kind === "changed") f.claims[0]!.statement = "评审后改动";
    expect(() => compileAuthoredModule(f.bundle, f.claims, kind === "changed" ? approval : f.approval(),
      () => kind === "source" ? "变更的正文" : chapter, kind === "blocked" ? new Set(["one"]) : undefined)).toThrow();
  });
  it("cannot infer full coverage from an empty inventory or a sample", () => {
    expect(() => assertFullCoverage({ inventory_sealed: false, domains: [], origins: [] }, [], 0)).toThrow("incomplete");
    const f = fixture(); f.bundle.scope = "full";
    expect(() => compileAuthoredModule(f.bundle, f.claims, { ...f.approval(), scope: "full" }, () => chapter)).toThrow("unreviewed");
  });
});
