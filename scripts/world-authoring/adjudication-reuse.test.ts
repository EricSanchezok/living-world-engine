import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { materializeSourceAdjudication, type SourceAdjudication } from "./source-adjudication";
import { validateReusableAdjudication } from "./adjudication-reuse";

function fixture() {
  const text = "村医保存家传药方。", body = `${text}\n`, policy = "Read the complete source.";
  const paragraphs = [{ id: "chapter-a:0", chapterId: "chapter-a", text, start: 0, end: [...text].length,
    sha256: contentHash(text), sourceVersion: "test-source" }];
  const batch = { id: "batch-0001", parts: [{ chapter_id: "chapter-a", start: 0, end: [...body].length, sha256: contentHash(body) }] };
  const audit = (pass: string) => ({ subjectId: batch.id, profileId: "old-profile", modelId: "old-model", modelMetadataHash: "metadata",
    modelCatalogHash: "old-catalog", promptVersion: "policy-v1", invocations: [{ requestHash: contentHash(pass), responseHash: "response",
      rawOutputHash: "output", resultKind: null, context: { sections: { paragraphs: { itemCount: 1, utf8Bytes: 80 } } } }] });
  const canonical: SourceAdjudication = { chapters: ["chapter-a"], records: [{ id: "batch-0001-object-1",
    sourceClaim: "村医保存家传药方", verdict: "supported", rationale: "叙述明确", correction: null, basis: "narration",
    opening: "unknown", existenceAtOpening: { status: "unknown", reason: "缺乏年代" }, validTime: "本章场景",
    learnedTime: "本章叙述", openingReason: "缺乏年代", evidence: [{ paragraph: "chapter-a:0" }] }],
    aliases: [], issues: [], omissions: [], identities: [] };
  const materialized = materializeSourceAdjudication(canonical, paragraphs);
  const report = { batchId: batch.id, chapters: canonical.chapters, approvedForRuntime: false, policyHash: "extract-policy", schemaHash: "extract-schema",
    identity: contentHash({ parts: batch.parts, policyHash: "extract-policy", schemaHash: "extract-schema", profileId: "old-profile", catalogHash: "old-catalog" }),
    audits: [audit("extract"), audit("review")], objects: [{ id: canonical.records[0]!.id, label: "村医", aliases: [], kind: "person",
      status: "machine-reviewed-needs-adjudication", evidence: materialized.records[0]!.evidence }], facts: [], issues: [] };
  const saved = { ...materialized, batchId: batch.id, sourceReportHash: contentHash(report), sourceParts: batch.parts,
    policyHash: contentHash(policy), schemaHash: "old-schema", audits: [audit("semantic")],
    identity: contentHash({ parts: batch.parts, sourceReportHash: contentHash(report), policyHash: contentHash(policy),
      schemaHash: "old-schema", profileId: "old-profile", catalogHash: "old-catalog" }) };
  return { text, body, policy, paragraphs, batch, report, saved, canonical };
}

describe("adjudication semantic reuse", () => {
  it("revalidates source and complete judgments while preserving the original model provenance", () => {
    const f = fixture(), before = structuredClone(f.saved);
    expect(validateReusableAdjudication(f.saved, f.report, f.batch, f.paragraphs, () => f.body, contentHash(f.policy))).toEqual(f.canonical);
    expect(f.saved).toEqual(before);
  });

  it("rejects source, candidate, policy, coverage, and semantic-contract drift", () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.body += "改"; f.batch.parts[0]!.end++; },
      (f: ReturnType<typeof fixture>) => { f.report.objects[0]!.label = "另一个人"; },
      (f: ReturnType<typeof fixture>) => { f.policy += "Changed semantic rule"; },
      (f: ReturnType<typeof fixture>) => { f.saved.records = []; },
      (f: ReturnType<typeof fixture>) => { f.saved.records[0]!.existenceAtOpening = null; },
      (f: ReturnType<typeof fixture>) => { f.saved.records[0]!.evidence[0]!.anchorSha256 = "wrong"; },
      (f: ReturnType<typeof fixture>) => { f.saved.audits[0]!.invocations[0]!.context.sections.paragraphs.itemCount = 0; },
    ]) {
      const f = fixture(); change(f);
      expect(() => validateReusableAdjudication(f.saved, f.report, f.batch, f.paragraphs, () => f.body, contentHash(f.policy))).toThrow();
    }
  });

  it("runs the actual plan and zero-call CLI without credentials or modifying saved reviews", () => {
    const f = fixture(), directory = mkdtempSync(path.join(tmpdir(), "adjudication-plan-"));
    const write = (file: string, value: string) => { const target = path.join(directory, file);
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, value); };
    const root = "worlds/fanren/authoring", savedFile = `${root}/adjudications/${f.batch.id}.json`;
    try {
      write("config/models.yaml", readFileSync("config/models.yaml", "utf8"));
      write(`${root}/adjudication-policy.md`, f.policy);
      write(`${root}/coverage/batches.json`, JSON.stringify([f.batch]));
      write(`${root}/coverage/chapters.jsonl`, JSON.stringify({ id: "chapter-a", source_version: "test-source" }));
      write(`${root}/extractions/${f.batch.id}.json`, JSON.stringify(f.report));
      write(savedFile, JSON.stringify(f.saved));
      write(".livingworld-cache/fanren-sources/chapters/chapter-a.txt", f.body);
      const run = (...args: string[]) => execFileSync(process.execPath, [createRequire(import.meta.url).resolve("tsx/cli"),
        path.resolve("scripts/world-authoring/adjudicate-fanren.ts"), ...args], { cwd: directory,
          env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8" });
      const plan = run("--plan").trim().split("\n").map(line => JSON.parse(line));
      expect(plan.at(-1)).toMatchObject({ reused: 1, pending: 0, generationRequests: 0, model: "deepseek-flash", effort: "low" });
      expect(readFileSync(path.join(directory, savedFile), "utf8")).toBe(JSON.stringify(f.saved));
      const fresh = run("--fresh", "--plan").trim().split("\n").map(line => JSON.parse(line));
      expect(fresh[0]).toMatchObject({ status: "planned-no-model-call", paragraphs: 1, records: 1 });
      expect(fresh[0].compactContextBytes).toBeLessThan(fresh[0].originalContextBytes);
      expect(run("--fresh", "--max-calls", "0")).toContain("stopped-before-paid-call");
      expect(readFileSync(path.join(directory, savedFile), "utf8")).toBe(JSON.stringify(f.saved));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
