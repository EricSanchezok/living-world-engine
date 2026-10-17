import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { sourceAdjudicationCatalog } from "./adjudication-catalog";
import { sourceRunnerAccountBlock } from "./source-runner-failure";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelOutputError } from "../../src/engine/models/model-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { indexSourceReports, type ReadingBatch } from "./authoring-index";
import type { SourceParagraph } from "./extraction-contract";
import { materializeSourceAdjudication, sourceAdjudicationSchema,
  sourceAdjudicationManifest, sourceAdjudicationSchemaFor, validateSourceAdjudication, type AdjudicationInput, type SourceAdjudication } from "./source-adjudication";

const root = path.resolve("worlds/fanren/authoring"), cache = path.resolve(".livingworld-cache/fanren-sources");
function json(file: string) { return JSON.parse(readFileSync(file, "utf8")); }
function save(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (file.startsWith(path.join(root, "adjudications") + path.sep) && existsSync(file)) {
    const previous = json(file);
    if (previous.identity !== Reflect.get(value as object, "identity")) {
      const archive = path.join(cache, "adjudications", "reports", path.basename(file, ".json"), `${previous.identity}.json`);
      mkdirSync(path.dirname(archive), { recursive: true });
      writeFileSync(archive, readFileSync(file));
    }
  }
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

async function main() {
  const argv = process.argv.slice(2);
  const argument = (name: string, fallback: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback;
  const start = argument("--start", "batch-0001"), count = Number(argument("--count", "1"));
  const concurrency = Number(argument("--concurrency", "1")), profileId = argument("--profile", "creation-deepseek");
  const baseProfileId = argument("--profile-base", profileId);
  const accountConcurrency = Number(argument("--account-concurrency", String(concurrency)));
  const modelOverride = argument("--model", "deepseek-v4-pro"), effortOverride = argument("--effort", "high");
  const thinking = argument("--thinking", "auto");
  if (!["auto", "enabled"].includes(thinking)) throw new Error("invalid adjudication thinking mode (auto, enabled)");
  if (effortOverride && !["low", "high", "max"].includes(effortOverride)) throw new Error("invalid adjudication effort (low, high, max)");
  const fresh = argv.includes("--fresh");
  if (![count, concurrency, accountConcurrency].every(value => Number.isSafeInteger(value) && value > 0) ||
    concurrency > 16 || accountConcurrency > 16) throw new Error("invalid count or concurrency (1–16)");
  const batches = json(path.join(root, "coverage/batches.json")) as ReadingBatch[];
  const first = batches.findIndex(batch => batch.id === start);
  if (first < 0) throw new Error("unknown starting batch");
  const selected = batches.slice(first, first + count);
  const sourceVersions = new Map<string, string>(readFileSync(path.join(root, "coverage/chapters.jsonl"), "utf8").trim().split("\n")
    .map(line => { const row = JSON.parse(line); return [row.id, row.source_version ?? "candidate-2fc16984"]; }));
  const system = readFileSync(path.join(root, "adjudication-policy.md"), "utf8");
  const policyHash = contentHash(system), legacySchemaHash = contentHash(sourceAdjudicationSchema.toJSONSchema());
  const baseCatalog = loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
  const catalog = sourceAdjudicationCatalog(baseCatalog, { profileId, baseProfileId, modelId: modelOverride,
    effort: effortOverride as "low" | "high" | "max", thinking: thinking as "auto" | "enabled", accountConcurrency });
  const registry = new ModelRegistry(catalog, path.join(cache, "model-runtime"));
  const gateway = createModelGateway(catalog, process.env, { registry, fetchForAccount: createModelFetchResolver(process.env) });
  await gateway.assertProfilesAvailable([profileId]);
  let next = 0, failed = 0, draining = false;
  const drain = () => { draining = true; process.stderr.write(`${JSON.stringify({ status: "draining", nextBatch: selected[next]?.id ?? null })}\n`); };
  process.on("SIGINT", drain);
  process.on("SIGTERM", drain);
  async function processBatch(batch: ReadingBatch) {
    const reportPath = path.join(root, "extractions", `${batch.id}.json`);
    if (!existsSync(reportPath)) throw new Error("source extraction is not available");
    const report = json(reportPath) as AdjudicationInput;
    const manifest = sourceAdjudicationManifest(report);
    const readChapter = (id: string) => readFileSync(path.join(cache, "chapters", `${id}.txt`), "utf8");
    indexSourceReports([report], [batch], readChapter);
    const paragraphs: SourceParagraph[] = [];
    for (const part of batch.parts) {
      const excerpt = [...readChapter(part.chapter_id)].slice(part.start, part.end).join("");
      if (contentHash(excerpt) !== part.sha256) throw new Error(`source part drift ${part.chapter_id}`);
      let offset = part.start;
      for (const line of excerpt.split("\n")) {
        const end = offset + [...line].length;
        if (line.trim()) paragraphs.push({ id: `${part.chapter_id}:${offset}`, chapterId: part.chapter_id,
          start: offset, end, text: line, sha256: contentHash(line), sourceVersion: sourceVersions.get(part.chapter_id) });
        offset = end + 1;
      }
    }
    const schema = sourceAdjudicationSchemaFor(report, paragraphs), schemaHash = contentHash(schema.toJSONSchema());
    const sourceReportHash = contentHash(report);
    const identity = contentHash({ parts: batch.parts, sourceReportHash, policyHash, schemaHash, profileId, catalogHash: catalog.hash });
    const destination = path.join(root, "adjudications", `${batch.id}.json`);
    if (existsSync(destination) && json(destination).identity === identity) {
      process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "already-source-reviewed" })}\n`);
      return;
    }
    const audits: unknown[] = [];
    let draft: unknown, problems: string | undefined;
    let priorDraft: { identity: string; fileHash: string; sourceReportHash: string; auditHash: string } | undefined;
    const started = Date.now();
    function finish(value: SourceAdjudication, attempts: number, recoveredFromCache = false) {
      const result = { ...materializeSourceAdjudication(value, paragraphs), batchId: batch.id, identity,
        sourceReportHash, sourceParts: batch.parts, policyHash, schemaHash,
        generatedAt: new Date().toISOString(), durationMs: Date.now() - started, audits: [...audits],
        evidenceMode: "complete-source-paragraph-ids",
        ...(priorDraft ? { priorDraft } : {}),
        execution: { concurrency, accountConcurrency, profileId, baseProfileId, attempts, recoveredFromCache, fresh,
          selector: catalog.profile(profileId).selector, inference: catalog.profile(profileId).inference } };
      save(destination, result);
      process.stdout.write(`${JSON.stringify({ batch: batch.id, status: result.status,
        records: result.records.length, unsupported: result.records.filter(record => record.verdict === "unsupported").length,
        ambiguous: result.records.filter(record => record.verdict === "ambiguous").length, omissions: result.omissions.length,
        unresolvedIssues: result.issues.filter(issue => issue.status !== "resolved-in-this-batch").length,
        recoveredFromCache, durationMs: result.durationMs })}\n`);
    }
    // Reuse validated responses with the same complete source/schema/model binding
    // before scheduling another call. Rejected raw outputs remain available.
    const currentDirectory = path.join(cache, "adjudications", batch.id, identity);
    let attemptOffset = 0;
    if (existsSync(currentDirectory)) {
      const currentFiles = readdirSync(currentDirectory).filter(file => /^\d+\.json$/u.test(file))
        .sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
      attemptOffset = currentFiles.length ? Number.parseInt(currentFiles.at(-1)!) + 1 : 0;
      const current = currentFiles.map(file => json(path.join(currentDirectory, file)))
        .filter(saved => saved.identity === identity && saved.sourceReportHash === sourceReportHash && saved.schemaHash === schemaHash && saved.policyHash === policyHash);
      const latest = current.at(-1);
      if (latest) {
        try {
          const value = schema.parse(latest.value);
          validateSourceAdjudication(value, report, paragraphs);
          audits.push(...current.map(saved => saved.audit));
          finish(value, current.length, true);
          return;
        } catch (error) {
          // Resume the last source-bound draft and append attempts; never overwrite raw evidence.
          draft = latest.value;
          problems = error instanceof Error ? error.message : String(error);
          audits.push(...current.map(saved => saved.audit));
          priorDraft = { identity: latest.identity, fileHash: contentHash(latest), sourceReportHash,
            auditHash: contentHash(latest.audit) };
        }
      }
    }
    // Failed legacy outputs may seed a targeted repair only when their complete
    // source, policy, schema, profile, and catalog identity still bind exactly.
    const historyDirectory = path.join(cache, "adjudications", batch.id);
    const previousFiles = [2, 1, 0].map(attempt => path.join(cache, "adjudications", `${batch.id}-${attempt}.json`));
    if (existsSync(historyDirectory)) for (const revision of readdirSync(historyDirectory)) {
      if (!/^[a-f0-9]{64}$/u.test(revision) || revision === identity) continue;
      previousFiles.push(...readdirSync(path.join(historyDirectory, revision)).filter(file => /^\d+\.json$/u.test(file))
        .map(file => path.join(historyDirectory, revision, file)));
    }
    for (const file of (fresh || draft ? [] : previousFiles).filter(file => existsSync(file)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)) {
      const saved = json(file), audit = saved.audit;
      const previousPolicy = audit?.promptVersion?.match(/^fanren-source-adjudication-(.+)$/u)?.[1];
      if (!previousPolicy) continue;
      const previousSchemas = saved.schemaHash ? [saved.schemaHash] : [schemaHash, legacySchemaHash];
      if (!previousSchemas.some(previousSchema => saved.identity === contentHash({ parts: batch.parts, sourceReportHash,
        policyHash: previousPolicy, schemaHash: previousSchema, profileId: audit.profileId, catalogHash: audit.modelCatalogHash }))) continue;
      draft = saved.value;
      priorDraft = { identity: saved.identity, fileHash: contentHash(saved), sourceReportHash, auditHash: contentHash(audit) };
      try { validateSourceAdjudication(schema.parse(draft), report, paragraphs); }
      catch (error) { problems = error instanceof Error ? error.message : String(error); }
      break;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const storedAttempt = attemptOffset + attempt;
      const requestIdentity = contentHash({ identity, attempt: storedAttempt, draft: draft ?? null, problems: problems ?? null });
      const local = path.join(cache, "adjudications", batch.id, identity, `${storedAttempt}.json`);
      if (existsSync(local) && json(local).requestIdentity === requestIdentity) {
        const saved = json(local);
        draft = saved.value;
        audits.push(saved.audit);
      } else {
        try {
          const result = await gateway.generateStructured({
            profileId, role: "creation", subjectId: batch.id, workloadId: "fanren-source-adjudication", batchId: `${batch.id}-semantic-${storedAttempt}`,
            promptVersion: `fanren-source-adjudication-${policyHash}`, schemaName: "fanren_source_adjudication", system,
            userPrompt: `${!draft ? "独立阅读全部正文，审查所有候选对象、事实、别名、已有问题与遗漏，返回完整裁决。" :
              "根据校验问题重新对照正文，返回完整审校记录；不要通过删掉待审条目来规避错误。"} 本批逐条判定必须包含 ${report.objects.length} 个对象和 ${report.facts.length} 个事实，共 ${report.objects.length + report.facts.length} 个输入编号。`,
            context: { batch: batch.id, paragraphs, reviewManifest: manifest, candidates: { chapters: report.chapters, objects: report.objects,
              facts: report.facts, issues: report.issues }, ...(draft ? { draft, problems } : {}) },
            schema, runtimeIdentity: { worldHash: `sha256:${identity}`, revision: 0 },
            jsonExamplePolicy: "omit", structuredOutputMode: "json-object-zod",
          });
          draft = result.value;
          audits.push(result.audit);
          save(local, { identity, sourceReportHash, policyHash, schemaHash, requestIdentity, value: draft, audit: result.audit });
        } catch (error) {
          if (!(error instanceof ModelOutputError) || error.rawValue === undefined) throw error;
          draft = error.rawValue;
          audits.push(error.audit);
          save(local, { identity, sourceReportHash, policyHash, schemaHash, requestIdentity, value: draft, audit: error.audit, rejected: true });
        }
      }
      try {
        const value = schema.parse(draft);
        validateSourceAdjudication(value, report, paragraphs);
        finish(value, storedAttempt + 1);
        return;
      } catch (error) {
        problems = error instanceof Error ? error.message : String(error);
        if (attempt === 2) throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (draining) return;
      const batch = selected[next++];
      if (!batch) return;
      try { await processBatch(batch); }
      catch (error) {
        failed++;
        const accountBlock = sourceRunnerAccountBlock(error);
        if (accountBlock) draining = true;
        const failure = { batch: batch.id, status: accountBlock ? "account-blocked" : "failed", accountBlock,
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(), audit: error && typeof error === "object" && "audit" in error ? error.audit : null };
        save(path.join(cache, "adjudications", `${batch.id}-failure.json`), failure);
        process.stderr.write(`${JSON.stringify(failure)}\n`);
        if (accountBlock) process.stderr.write(`${JSON.stringify({ status: "dispatch-stopped", nextBatch: selected[next]?.id ?? null, accountBlock })}\n`);
      }
    }
  }));
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
