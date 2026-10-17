import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { materializeSourceAdjudication, type SourceAdjudication } from "./source-adjudication";
import { validateReusableAdjudication } from "./adjudication-reuse";
import { createAdjudicationTransport } from "./adjudication-transport";
import { recoverRejectedAdjudication } from "./adjudication-syntax-recovery";
import { buildSourceAdjudicationEvidence } from "./source-evidence";

function fixture(chapterId = "chapter-a") {
  const text = "村医保存家传药方。", body = `${text}\n`, policy = "Read the complete source.";
  const paragraphs = [{ id: `${chapterId}:0`, chapterId, text, start: 0, end: [...text].length,
    sha256: contentHash(text), sourceVersion: "test-source" }];
  const batch = { id: "batch-0001", parts: [{ chapter_id: chapterId, start: 0, end: [...body].length, sha256: contentHash(body) }] };
  const audit = (pass: string) => ({ subjectId: batch.id, profileId: "old-profile", modelId: "old-model", modelMetadataHash: "metadata",
    modelCatalogHash: "old-catalog", promptVersion: "policy-v1", invocations: [{ requestHash: contentHash(pass), responseHash: "response",
      rawOutputHash: "output", resultKind: null, context: { sections: { paragraphs: { itemCount: 1, utf8Bytes: 80 } } } }] });
  const canonical: SourceAdjudication = { chapters: [chapterId], records: [{ id: "batch-0001-object-1",
    sourceClaim: "村医保存家传药方", verdict: "supported", rationale: "叙述明确", correction: null, basis: "narration",
    opening: "unknown", existenceAtOpening: { status: "unknown", reason: "缺乏年代" }, validTime: "本章场景",
    learnedTime: "本章叙述", openingReason: "缺乏年代", evidence: [{ paragraph: `${chapterId}:0` }] }],
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

function recoveredFixture(chapterId = "chapter-a") {
  const f = fixture(chapterId);
  const raw = JSON.stringify(createAdjudicationTransport(f.report, f.paragraphs).encode(f.canonical))
    .replace('"reason":"缺乏年代"}', '"reason":"缺乏年代","}');
  const schemaHash = contentHash("schema"), identity = contentHash({ parts: f.batch.parts, sourceReportHash: contentHash(f.report),
    policyHash: f.saved.policyHash, schemaHash, profileId: "old-profile", catalogHash: "old-catalog" });
  const audit = { ...f.saved.audits[0]!, invocations: [{ ...f.saved.audits[0]!.invocations[0]!,
    responseHash: contentHash(raw), rawOutputHash: contentHash(raw), outputDisposition: "rejected", finishReason: "stop" }] };
  const bindings = { identity, sourceReportHash: contentHash(f.report), schemaHash, policyHash: f.saved.policyHash };
  const cached = { ...bindings, transportVersion: "paragraph-refs-targeted-repair-v2", mode: "complete-review",
    value: raw, wireValue: raw, rejected: true, audit };
  const result = recoverRejectedAdjudication(cached, bindings, 3, f.report, f.paragraphs)!;
  const stored = { ...f.saved, ...bindings, audits: [audit], localSyntaxRecovery: result.evidence };
  return { f, raw, identity, cached, stored };
}

describe("adjudication semantic reuse", () => {
  it("replays local recovery provenance and refuses missing, changed, or stripped evidence", () => {
    const { f, raw, identity, cached, stored } = recoveredFixture();
    const read = (requestedIdentity: string, attempt: number) => {
      expect(requestedIdentity).toBe(identity); expect(attempt).toBe(3); return cached;
    };
    const validate = (saved: unknown, loader = read) => validateReusableAdjudication(saved, f.report, f.batch,
      f.paragraphs, () => f.body, f.saved.policyHash, loader);
    expect(validate(stored)).toEqual(f.canonical);
    expect(() => buildSourceAdjudicationEvidence(stored, f.report, f.batch, () => f.body)).toThrow("original source cache");
    expect(() => validateReusableAdjudication(stored, f.report, f.batch, f.paragraphs, () => f.body, f.saved.policyHash)).toThrow("original source cache");
    expect(() => validate(stored, () => { throw new Error("missing source cache"); })).toThrow("missing source cache");
    expect(() => validate(stored, () => ({ ...cached, rejected: false }))).toThrow("evidence drift");
    expect(() => validate(stored, () => ({ ...cached, value: raw + " " }))).toThrow("evidence drift");
    for (const mutate of [
      (copy: typeof stored) => { copy.localSyntaxRecovery.removed[0].start++; },
      (copy: typeof stored) => { copy.localSyntaxRecovery.recoveredTextHash = contentHash("other"); },
      (copy: typeof stored) => { copy.localSyntaxRecovery.canonicalValueHash = contentHash("other"); },
      (copy: typeof stored) => { copy.localSyntaxRecovery.auditHash = contentHash("other"); },
      (copy: typeof stored) => { copy.localSyntaxRecovery.cache.contentHash = contentHash("other"); },
      (copy: typeof stored) => { copy.records[0]!.sourceClaim = "另一种解读。"; },
      (copy: typeof stored) => { Reflect.deleteProperty(copy, "localSyntaxRecovery"); },
    ]) {
      const copy = structuredClone(stored); mutate(copy);
      expect(() => validate(copy)).toThrow();
    }
  });

  it("indexes derived evidence only while the original cache and recovery chain remain verifiable", () => {
    const { f, cached, stored } = recoveredFixture("qq-1");
    const directory = mkdtempSync(path.join(tmpdir(), "adjudication-derived-index-"));
    const root = "worlds/fanren/authoring";
    const write = (file: string, value: unknown) => { const target = path.join(directory, file);
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value)); };
    const reportFile = `${root}/adjudications/${f.batch.id}.json`;
    const cacheFile = `.livingworld-cache/fanren-sources/adjudications/${f.batch.id}/${cached.identity}/3.json`;
    try {
      write(`${root}/coverage/batches.json`, [f.batch]);
      write(`${root}/coverage/chapters.jsonl`, JSON.stringify({ id: "qq-1", source_version: "test-source",
        characters: [...f.body].length, sha256: contentHash(f.body), read: false, reviewed: false, extracted: true }));
      write(`${root}/coverage/regional-plan.json`, { modules: [] });
      mkdirSync(path.join(directory, root, "regions"), { recursive: true });
      write(`${root}/extractions/${f.batch.id}.json`, f.report);
      write(reportFile, stored);
      write(cacheFile, cached);
      write(".livingworld-cache/fanren-sources/chapters/qq-1.txt", f.body);
      const run = () => {
        execFileSync(process.execPath, [createRequire(import.meta.url).resolve("tsx/cli"), path.resolve("scripts/world-authoring/index-fanren.ts")],
          { cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8" });
        return JSON.parse(readFileSync(path.join(directory, root, "coverage/source-adjudication.jsonl"), "utf8"));
      };
      expect(run()).toMatchObject({ status: "source-semantic-evidence-produced", approvedForRuntime: false });
      rmSync(path.join(directory, cacheFile));
      expect(run()).toMatchObject({ status: "invalid-source-adjudication-evidence", message: expect.stringContaining("ENOENT") });
      write(cacheFile, { ...cached, value: cached.value + " " });
      expect(run()).toMatchObject({ status: "invalid-source-adjudication-evidence", message: expect.stringContaining("evidence drift") });
      write(cacheFile, cached);
      const modified = structuredClone(stored);
      modified.localSyntaxRecovery.recoveredTextHash = contentHash("other");
      write(reportFile, modified);
      expect(run()).toMatchObject({ status: "invalid-source-adjudication-evidence", message: expect.stringContaining("evidence drift") });
      Reflect.deleteProperty(modified, "localSyntaxRecovery");
      write(reportFile, modified);
      expect(run()).toMatchObject({ status: "invalid-source-adjudication-evidence", message: expect.stringContaining("derivation evidence") });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

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
