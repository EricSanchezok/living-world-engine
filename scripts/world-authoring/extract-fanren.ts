import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { loadModelCatalog, ModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { contentHash } from "../../src/engine/models/model-audit";
import { extractionSchema, validateExtraction, materializeExtraction, type SourceParagraph, type Extraction } from "./extraction-contract";
import { applyEditorialCorrections } from "./editorial-corrections";
import { ModelOutputError } from "../../src/engine/models/model-provider";

const root = path.resolve("worlds/fanren/authoring");
const cache = path.resolve(".livingworld-cache/fanren-sources");
interface Batch { id: string; parts: Array<{ chapter_id: string; start: number; end: number; sha256: string }>; characters: number }
function json(file: string) { return JSON.parse(readFileSync(file, "utf8")); }
function save(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}
function paragraphsFor(batch: Batch): SourceParagraph[] {
  const paragraphs: SourceParagraph[] = [];
  for (const part of batch.parts) {
    const body = [...readFileSync(path.join(cache, "chapters", `${part.chapter_id}.txt`), "utf8")];
    const excerpt = body.slice(part.start, part.end).join("");
    if (contentHash(excerpt) !== part.sha256) throw new Error(`source drift ${part.chapter_id}`);
    let offset = part.start;
    for (const line of excerpt.split("\n")) {
      const end = offset + [...line].length;
      if (line.trim()) paragraphs.push({ id: `${part.chapter_id}:${offset}`, chapterId: part.chapter_id,
        start: offset, end, text: line, sha256: contentHash(line) });
      offset = end + 1;
    }
  }
  return paragraphs;
}

async function main() {
  const argv = process.argv.slice(2);
  const argument = (name: string, fallback: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback;
  const start = argument("--start", "batch-0001"), count = Number(argument("--count", "1"));
  const concurrency = Number(argument("--concurrency", "1")), profileId = argument("--profile", "creation-deepseek");
  if (![count, concurrency].every(value => Number.isSafeInteger(value) && value > 0) || concurrency > 4) throw new Error("invalid batch count or concurrency (1–4)");
  const batches = json(path.join(root, "coverage/batches.json")) as Batch[];
  const first = batches.findIndex(batch => batch.id === start);
  if (first < 0) throw new Error("unknown starting batch");
  const selected = batches.slice(first, first + count);
  const system = readFileSync(path.join(root, "extraction-policy.md"), "utf8");
  const policyHash = contentHash(system), schemaHash = contentHash(extractionSchema.toJSONSchema());
  const baseCatalog = loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
  const catalog = new ModelCatalog({ schema_version: baseCatalog.schemaVersion, scheduler: baseCatalog.scheduler,
    registry: baseCatalog.registry, accounts: structuredClone(baseCatalog.accounts),
    profiles: { ...structuredClone(baseCatalog.profiles), [profileId]: {
      ...baseCatalog.profile(profileId), request_timeout_ms: 600000, max_output_tokens: 65536,
    } }, model_overrides: structuredClone(baseCatalog.modelOverrides) });
  const registry = new ModelRegistry(catalog, path.join(cache, "model-runtime"));
  const gateway = createModelGateway(catalog, process.env, { registry, fetchForAccount: createModelFetchResolver(process.env) });
  await gateway.assertProfilesAvailable([profileId]);
  let next = 0, failed = 0;
  async function processBatch(batch: Batch) {
    const paragraphs = paragraphsFor(batch), chapters = [...new Set(batch.parts.map(part => part.chapter_id))];
    const identity = contentHash({ parts: batch.parts, policyHash, schemaHash, profileId, catalogHash: catalog.hash });
    const reviewFile = path.join(root, "reviews", `${batch.id}-corrections.json`);
    const review = existsSync(reviewFile) ? json(reviewFile) : null;
    const editorialReviewHash = review ? contentHash(review) : null;
    const reportFile = path.join(root, "extractions", `${batch.id}.json`);
    if (existsSync(reportFile) && json(reportFile).identity === identity && json(reportFile).editorialReviewHash === editorialReviewHash) {
      process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "already-machine-reviewed" })}\n`); return;
    }
    let draft: unknown;
    let draftIssues: string | null = null;
    const audits: unknown[] = [];
    const started = Date.now();
    for (const pass of ["extract", "review"] as const) {
      const local = path.join(cache, "extractions", `${batch.id}-${pass}.json`);
      if (existsSync(local) && json(local).identity === identity) {
        const saved = json(local); draft = saved.value; audits.push(saved.audit);
        try { validateExtraction(extractionSchema.parse(draft), paragraphs, chapters); }
        catch (error) { if (pass === "review" && !review) throw error; draftIssues = error instanceof Error ? error.message : String(error); }
        continue;
      }
      const userPrompt = pass === "extract" ? "逐段整理所提供正文的全部世界设定与时间依据。" : "重新阅读正文，对照第一遍资料，返回纠正遗漏与错误后的完整资料。";
      let result;
      try { result = await gateway.generateStructured({
        profileId, role: "creation", subjectId: batch.id, workloadId: "fanren-source-extraction", batchId: `${batch.id}-${pass}`,
        promptVersion: `fanren-extraction-${policyHash}`, schemaName: "fanren_source_facts", system, userPrompt,
        context: { batch: batch.id, chapters, paragraphs, ...(draft ? { draft, draftIssues } : {}) }, schema: extractionSchema,
        runtimeIdentity: { worldHash: `sha256:${identity}`, revision: 0 },
        jsonExamplePolicy: "omit", structuredOutputMode: "json-object-zod",
      }); } catch (error) {
        if (pass !== "extract" || !(error instanceof ModelOutputError) || error.rawValue === undefined) throw error;
        // The second source pass can repair the rejected draft without paying
        // for an unrelated replacement first pass. Rejected data stays local.
        save(local, { identity, pass, value: error.rawValue, audit: error.audit, rejected: true });
        draft = error.rawValue; audits.push(error.audit);
        draftIssues = JSON.stringify(error.audit?.invocations.flatMap(invocation => invocation.issues) ?? error.message);
        continue;
      }
      save(local, { identity, pass, value: result.value, audit: result.audit });
      try { validateExtraction(result.value, paragraphs, chapters); }
      catch (error) { if (pass === "review" && !review) throw error; draftIssues = error instanceof Error ? error.message : String(error); }
      draft = result.value; audits.push(result.audit);
    }
    let accepted: Extraction = extractionSchema.parse(draft);
    if (review) accepted = applyEditorialCorrections(accepted, identity, review, paragraphs);
    validateExtraction(accepted, paragraphs, chapters);
    const report = { ...materializeExtraction(batch.id, accepted, paragraphs), identity, editorialReviewHash,
      method: "two-model-passes-with-deterministic-citation-validation", policyHash, schemaHash,
      generatedAt: new Date().toISOString(), durationMs: Date.now() - started, audits };
    save(reportFile, report);
    process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "machine-reviewed-needs-adjudication", objects: accepted.objects.length, facts: accepted.facts.length, durationMs: report.durationMs })}\n`);
  }
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const batch = selected[next++];
      if (!batch) return;
      try { await processBatch(batch); }
      catch (error) {
        failed++;
        const failure = { batch: batch.id, status: "failed", message: error instanceof Error ? error.message : String(error), at: new Date().toISOString(),
          audit: error && typeof error === "object" && "audit" in error ? error.audit : null,
          rawValue: error instanceof ModelOutputError ? error.rawValue : undefined };
        save(path.join(cache, "extractions", `${batch.id}-failure.json`), failure);
        process.stderr.write(`${JSON.stringify({ batch: batch.id, status: failure.status, message: failure.message })}\n`);
      }
    }
  }));
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
