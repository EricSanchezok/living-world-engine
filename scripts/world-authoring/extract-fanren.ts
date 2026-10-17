import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { loadModelCatalog, ModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { contentHash } from "../../src/engine/models/model-audit";
import { extractionSchema, validateExtraction, materializeExtraction, type SourceParagraph, type Extraction } from "./extraction-contract";
import { applyEditorialCorrections } from "./editorial-corrections";
import { relocateUniqueCitations, type CitationRelocation } from "./extraction-repair";
import { ModelOutputError } from "../../src/engine/models/model-provider";

const root = path.resolve("worlds/fanren/authoring");
const cache = path.resolve(".livingworld-cache/fanren-sources");
interface Batch { id: string; parts: Array<{ chapter_id: string; start: number; end: number; sha256: string }>; characters: number }
function json(file: string) { return JSON.parse(readFileSync(file, "utf8")); }
function save(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (file.startsWith(path.join(cache, "extractions") + path.sep) && existsSync(file)) {
    const previous = json(file);
    const nextIdentity = value && typeof value === "object" ? Reflect.get(value, "identity") : undefined;
    if (typeof nextIdentity === "string" && previous.identity !== nextIdentity) {
      const archive = path.join(cache, "extractions", "revisions", path.basename(file, ".json"), `${contentHash(previous)}.json`);
      mkdirSync(path.dirname(archive), { recursive: true });
      writeFileSync(archive, readFileSync(file));
    }
  }
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}
function paragraphsFor(batch: Batch, sourceVersions: Map<string, string>): SourceParagraph[] {
  const paragraphs: SourceParagraph[] = [];
  for (const part of batch.parts) {
    const body = [...readFileSync(path.join(cache, "chapters", `${part.chapter_id}.txt`), "utf8")];
    const excerpt = body.slice(part.start, part.end).join("");
    if (contentHash(excerpt) !== part.sha256) throw new Error(`source drift ${part.chapter_id}`);
    let offset = part.start;
    for (const line of excerpt.split("\n")) {
      const end = offset + [...line].length;
      if (line.trim()) paragraphs.push({ id: `${part.chapter_id}:${offset}`, chapterId: part.chapter_id,
        start: offset, end, text: line, sha256: contentHash(line), sourceVersion: sourceVersions.get(part.chapter_id) });
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
  const maxRepairs = Number(argument("--max-repairs", "2"));
  const accountConcurrency = Number(argument("--account-concurrency", String(concurrency)));
  if (![count, concurrency].every(value => Number.isSafeInteger(value) && value > 0) || concurrency > 16) throw new Error("invalid batch count or concurrency (1–16)");
  if (!Number.isSafeInteger(accountConcurrency) || accountConcurrency < 1 || accountConcurrency > 16) throw new Error("invalid account concurrency (1–16)");
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3) throw new Error("invalid repair bound (0–3)");
  const batches = json(path.join(root, "coverage/batches.json")) as Batch[];
  const sourceVersions = new Map<string, string>(readFileSync(path.join(root, "coverage/chapters.jsonl"), "utf8").trim().split("\n")
    .map(line => { const row = JSON.parse(line); return [row.id, row.source_version ?? "candidate-2fc16984"]; }));
  const first = batches.findIndex(batch => batch.id === start);
  if (first < 0) throw new Error("unknown starting batch");
  const selected = batches.slice(first, first + count);
  const system = readFileSync(path.join(root, "extraction-policy.md"), "utf8");
  const policyHash = contentHash(system), schemaHash = contentHash(extractionSchema.toJSONSchema());
  const baseCatalog = loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
  const accountId = baseCatalog.profile(profileId).account_id;
  const accounts = { ...structuredClone(baseCatalog.accounts),
    [accountId]: { ...baseCatalog.accounts[accountId]!, max_concurrency: accountConcurrency } };
  const catalog = new ModelCatalog({ schema_version: baseCatalog.schemaVersion, scheduler: baseCatalog.scheduler,
    registry: baseCatalog.registry, accounts,
    profiles: { ...structuredClone(baseCatalog.profiles), [profileId]: {
      ...baseCatalog.profile(profileId), request_timeout_ms: 600000, max_output_tokens: 65536,
    } }, model_overrides: structuredClone(baseCatalog.modelOverrides) });
  const registry = new ModelRegistry(catalog, path.join(cache, "model-runtime"));
  const gateway = createModelGateway(catalog, process.env, { registry, fetchForAccount: createModelFetchResolver(process.env) });
  await gateway.assertProfilesAvailable([profileId]);
  let next = 0, failed = 0, draining = false;
  const drain = () => { draining = true; process.stderr.write(`${JSON.stringify({ status: "draining", nextBatch: selected[next]?.id ?? null })}\n`); };
  process.on("SIGINT", drain);
  process.on("SIGTERM", drain);
  async function processBatch(batch: Batch) {
    const paragraphs = paragraphsFor(batch, sourceVersions), chapters = [...new Set(batch.parts.map(part => part.chapter_id))];
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
        catch (error) { draftIssues = error instanceof Error ? error.message : String(error); }
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
        if (!(error instanceof ModelOutputError) || error.rawValue === undefined) throw error;
        // Every rejected source pass remains resumable with its original audit.
        // Later source review receives the rejected draft and validation issues.
        save(local, { identity, pass, value: error.rawValue, audit: error.audit, rejected: true });
        draft = error.rawValue; audits.push(error.audit);
        draftIssues = JSON.stringify(error.audit?.invocations.flatMap(invocation => invocation.issues) ?? error.message);
        continue;
      }
      save(local, { identity, pass, value: result.value, audit: result.audit });
      try { validateExtraction(result.value, paragraphs, chapters); }
      catch (error) { draftIssues = error instanceof Error ? error.message : String(error); }
      draft = result.value; audits.push(result.audit);
    }
    // Mechanical relocation never changes an anchor or resolves ambiguity.
    // A model repair re-reads the complete source and stays a candidate report.
    let accepted: Extraction | undefined;
    const relocations: Array<CitationRelocation & { pass: number }> = [];
    let modelRepairPasses = 0;
    for (let repairPass = 0; repairPass <= maxRepairs; repairPass++) {
      try {
        if (review) {
          accepted = applyEditorialCorrections(draft as Extraction, identity, review, paragraphs);
        } else {
          const repaired = relocateUniqueCitations(draft, paragraphs);
          accepted = repaired.value;
          relocations.push(...repaired.relocations.map(relocation => ({ ...relocation, pass: repairPass })));
          draft = accepted;
        }
        validateExtraction(accepted, paragraphs, chapters);
        break;
      } catch (error) {
        accepted = undefined;
        draftIssues = error instanceof Error ? error.message : String(error);
        if (review || repairPass === maxRepairs) throw error;
      }
      const pass = `repair-${repairPass + 1}`;
      const repairIdentity = contentHash({ identity, pass, draft, draftIssues, policy: "source-targeted-repair-v1" });
      const local = path.join(cache, "extractions", `${batch.id}-${pass}.json`);
      if (existsSync(local) && json(local).repairIdentity === repairIdentity) {
        const saved = json(local);
        draft = saved.value;
        audits.push(saved.audit);
        modelRepairPasses++;
        continue;
      }
      try {
        const result = await gateway.generateStructured({
          profileId, role: "creation", subjectId: batch.id, workloadId: "fanren-source-extraction", batchId: `${batch.id}-${pass}`,
          promptVersion: `fanren-extraction-repair-v1-${policyHash}`, schemaName: "fanren_source_facts", system,
          userPrompt: "对照完整原文修正列出的校验错误，返回完整资料。引用必须是所指段落连续出现的原文，不得改写后当成引文。不要删除正确事实来回避引用定位；确无依据的条目须移入问题清单。复核章节、身份、条件和时间，不能把这次修复视为世界开篇审定。",
          context: { batch: batch.id, chapters, paragraphs, draft, draftIssues }, schema: extractionSchema,
          runtimeIdentity: { worldHash: `sha256:${identity}`, revision: 0 },
          jsonExamplePolicy: "omit", structuredOutputMode: "json-object-zod",
        });
        save(local, { identity, repairIdentity, pass, value: result.value, audit: result.audit });
        draft = result.value;
        audits.push(result.audit);
      } catch (error) {
        if (!(error instanceof ModelOutputError) || error.rawValue === undefined) throw error;
        save(local, { identity, repairIdentity, pass, value: error.rawValue, audit: error.audit, rejected: true });
        draft = error.rawValue;
        audits.push(error.audit);
      }
      modelRepairPasses++;
    }
    if (!accepted) throw new Error("source extraction did not produce an accepted candidate");
    const report = { ...materializeExtraction(batch.id, accepted, paragraphs), identity, editorialReviewHash,
      method: "two-source-passes-with-validated-targeted-repair", policyHash, schemaHash,
      generatedAt: new Date().toISOString(), durationMs: Date.now() - started, audits,
      citationRelocations: relocations, modelRepairPasses,
      execution: { concurrency, accountConcurrency, profileId, maxRepairs } };
    save(reportFile, report);
    process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "machine-reviewed-needs-adjudication", objects: accepted.objects.length, facts: accepted.facts.length, durationMs: report.durationMs })}\n`);
  }
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (draining) return;
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
