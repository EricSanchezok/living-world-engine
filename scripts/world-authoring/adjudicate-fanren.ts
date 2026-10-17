import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadModelCatalog, type ModelCatalog } from "../../src/engine/models/model-catalog";
import { sourceAdjudicationCatalog } from "./adjudication-catalog";
import { sourceRunnerAccountBlock, sourceRunnerAccountFetch, sourceRunnerCallIfActive } from "./source-runner-failure";
import { sourceValidationDiagnostics } from "./source-validation-diagnostics";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelOutputError } from "../../src/engine/models/model-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { indexSourceReports, type ReadingBatch } from "./authoring-index";
import type { SourceParagraph } from "./extraction-contract";
import { createAdjudicationTransport } from "./adjudication-transport";
import { createAdjudicationRepair } from "./adjudication-repair";
import { validateReusableAdjudication } from "./adjudication-reuse";
import { materializeSourceAdjudication,
  sourceAdjudicationManifest, sourceAdjudicationSchemaFor, validateSourceAdjudication, type AdjudicationInput, type SourceAdjudication } from "./source-adjudication";

const root = path.resolve("worlds/fanren/authoring"), cache = path.resolve(".livingworld-cache/fanren-sources");
function json(file: string) { return JSON.parse(readFileSync(file, "utf8")); }
function save(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (file.startsWith(path.join(root, "adjudications") + path.sep) && existsSync(file)) {
    const previous = json(file);
    if (contentHash(previous) !== contentHash(value)) {
      const archive = path.join(cache, "adjudications", "reports", path.basename(file, ".json"), `${previous.identity}-${contentHash(previous)}.json`);
      mkdirSync(path.dirname(archive), { recursive: true });
      writeFileSync(archive, readFileSync(file));
    }
  }
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export async function adjudicateFanren(argv = process.argv.slice(2),
  gatewayFactory?: (catalog: ModelCatalog, guardFetch: (transport: typeof fetch) => typeof fetch) => ReturnType<typeof createModelGateway>) {
  const argument = (name: string, fallback: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback;
  const start = argument("--start", "batch-0001"), count = Number(argument("--count", "1"));
  const concurrency = Number(argument("--concurrency", "1")), profileId = argument("--profile", "creation-deepseek");
  const baseProfileId = argument("--profile-base", profileId);
  const accountConcurrency = Number(argument("--account-concurrency", String(concurrency)));
  const modelOverride = argument("--model", "deepseek-flash"), effortOverride = argument("--effort", "high");
  const thinking = argument("--thinking", "auto");
  if (!["auto", "enabled"].includes(thinking)) throw new Error("invalid adjudication thinking mode (auto, enabled)");
  if (effortOverride && !["low", "high", "max"].includes(effortOverride)) throw new Error("invalid adjudication effort (low, high, max)");
  const fresh = argv.includes("--fresh");
  const planOnly = argv.includes("--plan"), maxCalls = Number(argument("--max-calls", String(count * 3)));
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) throw new Error("invalid maximum paid calls");
  if (![count, concurrency, accountConcurrency].every(value => Number.isSafeInteger(value) && value > 0) ||
    concurrency > 16 || accountConcurrency > 16) throw new Error("invalid count or concurrency (1–16)");
  const batches = json(path.join(root, "coverage/batches.json")) as ReadingBatch[];
  const first = batches.findIndex(batch => batch.id === start);
  if (first < 0) throw new Error("unknown starting batch");
  const selected = batches.slice(first, first + count);
  const sourceVersions = new Map<string, string>(readFileSync(path.join(root, "coverage/chapters.jsonl"), "utf8").trim().split("\n")
    .map(line => { const row = JSON.parse(line); return [row.id, row.source_version ?? "candidate-2fc16984"]; }));
  const system = readFileSync(path.join(root, "adjudication-policy.md"), "utf8");
  const policyHash = contentHash(system), transportVersion = "paragraph-refs-targeted-repair-v2";
  const transportSystem = `${system}\n\n## 传输与局部修复\n正文完整提供。p 编号是精确段落定位的可逆短编号；候选中的 quote 保留原引文范围。若 context.revisionRequest.repair 存在，本次只输出所列替换条目，程序保留其余条目并合成完整审校记录后重新执行全部校验。完整性要求针对合并后的记录；本次输出结构以提供的补丁 schema 为准。不得补丁外改写、漏掉修复目标或删除已发现的遗漏。每条替换记录的证据、sourceClaim、时间与判定要求均不变。`;
  const baseCatalog = loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
  const catalog = sourceAdjudicationCatalog(baseCatalog, { profileId, baseProfileId, modelId: modelOverride,
    effort: effortOverride as "low" | "high" | "max", thinking: thinking as "auto" | "enabled", accountConcurrency });
  let next = 0, failed = 0, draining = false, generationRequests = 0, reused = 0, pending = 0, completed = 0;
  const cancelPending = new AbortController();
  const stopDispatch = () => { draining = true; cancelPending.abort(); };
  const guardFetch = (transport: typeof fetch) => sourceRunnerAccountFetch(transport, stopDispatch);
  let gatewayPromise: Promise<ReturnType<typeof createModelGateway>> | undefined;
  const getGateway = () => gatewayPromise ??= (async () => {
    const registry = new ModelRegistry(catalog, path.join(cache, "model-runtime"));
    const transports = createModelFetchResolver(process.env);
    const gateway = gatewayFactory?.(catalog, guardFetch) ?? createModelGateway(catalog, process.env, { registry, maxTransportAttempts: 1,
      fetchForAccount: (id, account) => guardFetch(transports(id, account) ?? fetch) });
    await gateway.assertProfilesAvailable([profileId]);
    return gateway;
  })();
  const drain = () => { stopDispatch();
    process.stderr.write(`${JSON.stringify({ status: "draining", nextBatch: selected[next]?.id ?? null })}\n`); };
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
    if (!fresh && existsSync(destination)) {
      try {
        validateReusableAdjudication(json(destination), report, batch, paragraphs, readChapter, policyHash);
        reused++;
        process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "already-source-reviewed" })}\n`);
        return;
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "review-not-reusable",
          reason: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }
    pending++;
    const transport = createAdjudicationTransport(report, paragraphs);
    const initialContext = { batch: batch.id, paragraphs: transport.paragraphs, reviewManifest: manifest,
      candidates: transport.candidates };
    if (planOnly) {
      const originalContext = { batch: batch.id, paragraphs, reviewManifest: manifest,
        candidates: { chapters: report.chapters, objects: report.objects, facts: report.facts, issues: report.issues } };
      process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "planned-no-model-call", paragraphs: paragraphs.length,
        records: manifest.counts.records, originalContextBytes: Buffer.byteLength(JSON.stringify(originalContext)),
        compactContextBytes: Buffer.byteLength(JSON.stringify(initialContext)),
        originalSchemaBytes: Buffer.byteLength(JSON.stringify(schema.toJSONSchema())),
        compactSchemaBytes: Buffer.byteLength(JSON.stringify(transport.jsonSchema(schema))) })}\n`);
      return;
    }
    const audits: unknown[] = [];
    let draft: unknown, problems: string | undefined;
    let lastRepairFailure: { value: unknown; problems: string } | undefined;
    let priorDraft: { identity: string; fileHash: string; sourceReportHash: string; auditHash: string } | undefined;
    const started = Date.now();
    function finish(value: SourceAdjudication, attempts: number, recoveredFromCache = false) {
      const result = { ...materializeSourceAdjudication(value, paragraphs), batchId: batch.id, identity,
        sourceReportHash, sourceParts: batch.parts, policyHash, schemaHash,
        generatedAt: new Date().toISOString(), durationMs: Date.now() - started, audits: [...audits],
        evidenceMode: "complete-source-paragraph-ids",
        ...(priorDraft ? { priorDraft } : {}),
        execution: { concurrency, accountConcurrency, profileId, baseProfileId, attempts, recoveredFromCache, fresh,
          transportVersion, transportPromptHash: contentHash(transportSystem),
          selector: catalog.profile(profileId).selector, inference: catalog.profile(profileId).inference } };
      save(destination, result);
      completed++;
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
      if (latest && !fresh) {
        try {
          const value = schema.parse(latest.value);
          validateSourceAdjudication(value, report, paragraphs);
          audits.push(...current.map(saved => saved.audit));
          finish(value, current.length, true);
          return;
        } catch (error) {
          // Resume the last source-bound draft and append attempts; never overwrite raw evidence.
          draft = latest.value;
          lastRepairFailure = latest.lastRepairFailure;
          problems = sourceValidationDiagnostics(error, draft);
          audits.push(...current.map(saved => saved.audit));
          priorDraft = { identity: latest.identity, fileHash: contentHash(latest), sourceReportHash,
            auditHash: contentHash(latest.audit) };
        }
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const storedAttempt = attemptOffset + attempt;
      const repair = draft ? createAdjudicationRepair(draft, report, paragraphs) : undefined;
      const requestedSchema = repair?.schema ?? schema;
      const requestIdentity = contentHash({ identity, transportVersion, attempt: storedAttempt, draft: draft ?? null,
        problems: problems ?? null, lastRepairFailure: lastRepairFailure ?? null });
      const local = path.join(cache, "adjudications", batch.id, identity, `${storedAttempt}.json`);
      if (existsSync(local) && json(local).requestIdentity === requestIdentity) {
        const saved = json(local);
        draft = saved.value;
        lastRepairFailure = saved.lastRepairFailure;
        audits.push(saved.audit);
      } else {
        if (draining || generationRequests >= maxCalls) {
          process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "stopped-before-paid-call", generationRequests, maxCalls })}\n`);
          return;
        }
        const gateway = await getGateway();
        let wireValue: unknown;
        try {
          const dispatch = await sourceRunnerCallIfActive(() => draining || generationRequests >= maxCalls, () => {
            generationRequests++;
            return gateway.generateStructured({
            profileId, role: "creation", subjectId: batch.id, workloadId: "fanren-source-adjudication", batchId: `${batch.id}-semantic-${storedAttempt}`,
            promptVersion: `fanren-source-adjudication-${policyHash}`, schemaName: "fanren_source_adjudication", system: transportSystem,
            userPrompt: `独立阅读全部正文，审查候选对象、事实、别名、问题与遗漏。本批完整审校覆盖 ${report.objects.length} 个对象和 ${report.facts.length} 个事实。若 revisionRequest.repair 存在，仅返回指定条目的替换补丁，其他条目由程序原样保留；否则返回完整审校记录。revisionRequest 内已有草稿和失败补丁只用于定位错误，须重新对照正文，不得删项规避校验。证据使用 paragraphs 中的 p 编号；它们精确对应原文段落。候选 quote 为原引用片段，仍须通读全部段落核对上下文。`,
            context: { ...initialContext, ...(draft ? { revisionRequest: repair ? { repair: transport.encode(repair.context),
              ...(lastRepairFailure ? { lastRepairFailure: transport.encode(lastRepairFailure) } : {}) }
              : { draft: transport.encode(draft), problems } } : {}) },
            schema: z.preprocess(value => transport.decode(value), requestedSchema), wireJsonSchema: transport.jsonSchema(requestedSchema),
            runtimeIdentity: { worldHash: `sha256:${identity}`, revision: 0 },
            cancelPendingSignal: cancelPending.signal,
            jsonExamplePolicy: "omit", structuredOutputMode: "json-object-zod",
          }); });
          if (dispatch.status === "stopped") {
            process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "stopped-before-paid-repair", storedAttempt })}\n`);
            return;
          }
          const result = dispatch.value;
          wireValue = transport.encode(result.value);
          audits.push(result.audit);
          try { draft = repair ? repair.merge(result.value) : result.value; lastRepairFailure = undefined; }
          catch (error) { lastRepairFailure = { value: result.value, problems: sourceValidationDiagnostics(error, result.value) }; }
          save(local, { identity, sourceReportHash, policyHash, schemaHash, requestIdentity, transportVersion,
            mode: repair ? "targeted-repair" : "complete-review", value: draft, wireValue, lastRepairFailure, audit: result.audit });
        } catch (error) {
          if (!(error instanceof ModelOutputError) || error.rawValue === undefined) throw error;
          wireValue = error.rawValue;
          const returned = transport.decode(wireValue);
          if (!repair) draft = returned;
          else try { draft = repair.merge(returned); lastRepairFailure = undefined; }
          catch (mergeError) { lastRepairFailure = { value: returned, problems: sourceValidationDiagnostics(mergeError, returned) }; }
          audits.push(error.audit);
          save(local, { identity, sourceReportHash, policyHash, schemaHash, requestIdentity, transportVersion,
            mode: repair ? "targeted-repair" : "complete-review", value: draft, wireValue, lastRepairFailure, audit: error.audit, rejected: true });
        }
      }
      try {
        const value = schema.parse(draft);
        validateSourceAdjudication(value, report, paragraphs);
        finish(value, storedAttempt + 1);
        return;
      } catch (error) {
        problems = sourceValidationDiagnostics(error, draft);
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
        if (draining && error instanceof Error && error.name === "AbortError") {
          process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "cancelled-before-dispatch" })}\n`);
          continue;
        }
        failed++;
        const accountBlock = sourceRunnerAccountBlock(error);
        if (accountBlock) stopDispatch();
        const failure = { batch: batch.id, status: accountBlock ? "account-blocked" : "failed", accountBlock,
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(), audit: error && typeof error === "object" && "audit" in error ? error.audit : null };
        save(path.join(cache, "adjudications", `${batch.id}-failure.json`), failure);
        process.stderr.write(`${JSON.stringify(failure)}\n`);
        if (accountBlock) process.stderr.write(`${JSON.stringify({ status: "dispatch-stopped", nextBatch: selected[next]?.id ?? null, accountBlock })}\n`);
      }
    }
  }));
  process.off("SIGINT", drain); process.off("SIGTERM", drain);
  process.stdout.write(`${JSON.stringify({ status: planOnly ? "plan-complete" : draining ? "stopped" :
    pending > completed && generationRequests >= maxCalls ? "call-limit-reached" : failed ? "failed" : "finished",
    reused, pending, completed, failed, generationRequests, maxCalls, model: modelOverride, effort: effortOverride })}\n`);
  process.exitCode = failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  adjudicateFanren().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
