import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelOutputError } from "../../src/engine/models/model-provider";
import { sourceAdjudicationCatalog } from "./adjudication-catalog";
import { sourceRunnerAccountBlock, sourceRunnerCallIfActive } from "./source-runner-failure";
import { sourceValidationDiagnostics } from "./source-validation-diagnostics";
import { buildSourceAdjudicationEvidence } from "./source-evidence";
import type { ReadingBatch } from "./authoring-index";
import type { SourceParagraph } from "./extraction-contract";
import { editorialModuleSnapshot, editorialOpeningSnapshot, regionalProposalSchemaFor, validateRegionalProposal, type RegionalProposalTask } from "./regional-proposals";

const root = path.resolve("worlds/fanren/authoring"), cache = path.resolve(".livingworld-cache/fanren-sources");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function save(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`); renameSync(`${file}.tmp`, file);
}
type Queue = { inputHash: string; moduleId: string; candidates: Array<{ id: string; kind: string; batchId: string; reportHash: string }> };
type EditorialRecord = Record<string, unknown> & { id: string; evidence?: Array<{ chapterId: string }> };

async function main() {
  const args = process.argv.slice(2), argument = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
  const concurrency = Number(argument("--concurrency", "4")), accountConcurrency = Number(argument("--account-concurrency", "16"));
  const count = Number(argument("--count", "398")), start = argument("--start", "batch-0001"), selectedModules = argument("--modules", "").split(",").filter(Boolean);
  const modelId = argument("--model", "deepseek-flash");
  const thinking = argument("--thinking", "disabled");
  if (!["enabled", "disabled"].includes(thinking)) throw new Error("regional thinking must be enabled or disabled");
  if (argument("--effort", "low") !== "low") throw new Error("regional proposal effort must be low");
  if (![concurrency, accountConcurrency, count].every(value => Number.isSafeInteger(value) && value > 0) || concurrency > accountConcurrency || accountConcurrency > 16) throw new Error("invalid regional proposal concurrency or count");
  const profileId = "creation-deepseek", system = readFileSync(path.join(root, "regional-proposal-policy.md"), "utf8"), policyHash = contentHash(system);
  const catalog = sourceAdjudicationCatalog(loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml")), {
    profileId, baseProfileId: profileId, modelId, effort: "low", thinking: thinking as "enabled" | "disabled", accountConcurrency });
  const gateway = createModelGateway(catalog, process.env, { registry: new ModelRegistry(catalog, path.join(cache, "regional-model-runtime")), fetchForAccount: createModelFetchResolver(process.env) });
  await gateway.assertProfilesAvailable([profileId]);
  const allBatches = json(path.join(root, "coverage/batches.json")) as ReadingBatch[];
  const first = allBatches.findIndex(batch => batch.id === start); if (first < 0) throw new Error("unknown start batch");
  const batches = allBatches.slice(first, first + count);
  const plan = json(path.join(root, "coverage/regional-plan.json")) as { modules: Array<{ id: string; search_terms: string[] }> };
  const moduleIds = new Set(plan.modules.map(entry => entry.id));
  for (const id of selectedModules) if (!moduleIds.has(id)) throw new Error(`unknown requested module ${id}`);
  const queues: Queue[] = plan.modules.filter(entry => !selectedModules.length || selectedModules.includes(entry.id)).map(entry => json(path.join(root, "coverage/regional-queues", `${entry.id}.json`)));
  const regionSnapshots = new Map<string, ReturnType<typeof editorialModuleSnapshot>>();
  const targetCatalog: Array<{ id: string; moduleId: string; label: unknown }> = [];
  const openingSnapshot = editorialOpeningSnapshot(json(path.join(root, "modules/opening-sample.json")), json(path.join(root, "claims/opening-sample.json")));
  for (const entry of [...openingSnapshot.entities, ...openingSnapshot.claims]) targetCatalog.push({ id: entry.id, moduleId: "opening-sample", label: entry.name ?? entry.label ?? entry.statement });
  for (const directory of readdirSync(path.join(root, "regions"))) {
    const files = ["module", "claims", "subjects"].map(name => path.join(root, "regions", directory, `${name}.json`));
    if (!files.slice(0, 2).every(file => existsSync(file))) continue;
    const snapshot = editorialModuleSnapshot(json(files[0]!), json(files[1]!), existsSync(files[2]!) ? json(files[2]!) : []);
    regionSnapshots.set(directory, snapshot);
    for (const entry of [...snapshot.entities, ...snapshot.claims, ...snapshot.subjects]) targetCatalog.push({ id: entry.id, moduleId: directory, label: entry.name ?? entry.label ?? entry.statement });
  }
  const targetIds = new Set([...moduleIds, ...targetCatalog.map(entry => entry.id)]);
  const sourceRows = new Map<string, { sha256: string; source_version?: string }>(readFileSync(path.join(root, "coverage/chapters.jsonl"), "utf8").trim().split("\n").map(line => { const row = JSON.parse(line); return [row.id, row]; }));
  const body = (id: string) => {
    if (!sourceRows.has(id) || !/^qq-\d+$/u.test(id)) throw new Error(`unknown source ${id}`);
    const text = readFileSync(path.join(cache, "chapters", `${id}.txt`), "utf8");
    if (contentHash(text) !== sourceRows.get(id)!.sha256) throw new Error(`source baseline drift ${id}`); return text;
  };
  let next = 0, failed = 0, waiting = 0, completed = 0, draining = false;
  const drain = () => { draining = true; process.stderr.write(`${JSON.stringify({ status: "draining-regional-proposals", nextBatch: batches[next]?.id })}\n`); };
  process.on("SIGTERM", drain); process.on("SIGINT", drain);
  async function processBatch(batch: ReadingBatch) {
    const activeQueues = queues.filter(queue => queue.candidates.some(candidate => candidate.batchId === batch.id));
    if (!activeQueues.length) return;
    const adjudicationFile = path.join(root, "adjudications", `${batch.id}.json`);
    if (!existsSync(adjudicationFile)) { waiting++; process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "waiting-source-adjudication" })}\n`); return; }
    const extraction = json(path.join(root, "extractions", `${batch.id}.json`)), adjudication = json(adjudicationFile);
    const sourceEvidence = buildSourceAdjudicationEvidence(adjudication, extraction, batch, body);
    const originals = new Map<string, EditorialRecord>([...extraction.objects, ...extraction.facts, ...extraction.issues].map(entry => [entry.id, entry]));
    const tasks: RegionalProposalTask[] = [], candidates: unknown[] = [];
    for (const queue of activeQueues) for (const candidate of queue.candidates.filter(entry => entry.batchId === batch.id)) {
      if (candidate.reportHash !== contentHash(extraction)) throw new Error(`regional queue source drift ${candidate.id}`);
      const record = originals.get(candidate.id); if (!record?.evidence?.length) throw new Error(`missing candidate source ${candidate.id}`);
      tasks.push({ moduleId: queue.moduleId, candidateId: candidate.id, sourceChapterIds: [...new Set(record.evidence.map(ref => ref.chapterId))] });
      candidates.push({ moduleId: queue.moduleId, candidateId: candidate.id, kind: candidate.kind, record });
    }
    const editorialFindings = ["editorial-findings.json", "source-semantic-counterexamples.json"].flatMap(name => {
      const file = path.join(root, "reviews", name);
      return existsSync(file) ? json(file).findings.filter((finding: { candidateId: string; reportHash: string }) => originals.has(finding.candidateId) && finding.reportHash === contentHash(extraction)) : [];
    });
    const paragraphs: SourceParagraph[] = [];
    for (const part of batch.parts) {
      const text = [...body(part.chapter_id)].slice(part.start, part.end).join(""); let offset = part.start;
      if (contentHash(text) !== part.sha256) throw new Error(`source part drift ${part.chapter_id}`);
      for (const line of text.split("\n")) { const end = offset + [...line].length;
        if (line.trim()) paragraphs.push({ id: `${part.chapter_id}:${offset}`, chapterId: part.chapter_id, start: offset, end, text: line, sha256: contentHash(line), sourceVersion: sourceRows.get(part.chapter_id)!.source_version }); offset = end + 1;
      }
    }
    const modules = activeQueues.map(queue => ({ moduleId: queue.moduleId, queueInputHash: queue.inputHash,
      scope: plan.modules.find(entry => entry.id === queue.moduleId), snapshot: regionSnapshots.get(queue.moduleId) ?? null }));
    const schema = regionalProposalSchemaFor(tasks, paragraphs), schemaHash = contentHash(schema.toJSONSchema());
    const bindings = { batchId: batch.id, sourceParts: batch.parts, extractionHash: contentHash(extraction), adjudicationHash: contentHash(adjudication), sourceEvidenceHash: contentHash(sourceEvidence),
      modules: modules.map(module => ({ moduleId: module.moduleId, queueInputHash: module.queueInputHash, moduleHash: module.snapshot?.hash ?? null })), openingModuleHash: openingSnapshot.hash, taskManifestHash: contentHash(tasks), ...(editorialFindings.length ? { editorialFindingsHash: contentHash(editorialFindings) } : {}), targetCatalogHash: contentHash(targetCatalog), policyHash, schemaHash, catalogHash: catalog.hash };
    const identity = contentHash(bindings), destination = path.join(root, "regional-proposals", `${batch.id}.json`);
    if (existsSync(destination) && json(destination).identity === identity) { completed++; process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "already-proposed", tasks: tasks.length })}\n`); return; }
    const directory = path.join(cache, "regional-proposals", batch.id, identity);
    const old = existsSync(directory) ? readdirSync(directory).filter(file => /^\d+\.json$/u.test(file)).sort((a, b) => parseInt(a) - parseInt(b)) : [];
    const audits: unknown[] = old.map(file => json(path.join(directory, file)).audit);
    let draft: unknown, problems: string | undefined;
    if (old.length) draft = json(path.join(directory, old.at(-1)!)).value;
    const finish = (value: ReturnType<typeof validateRegionalProposal>, recovered: boolean) => {
      const byId = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph]));
      if (existsSync(destination) && json(destination).identity !== identity) save(path.join(cache, "regional-proposals", "reports", batch.id, `${json(destination).identity}.json`), json(destination));
      save(destination, { formatVersion: 1, status: "regional-preliminary-opinions-not-editorial-dispositions", approvedForRuntime: false, identity, bindings, tasks,
        generatedAt: new Date().toISOString(), execution: { concurrency, accountConcurrency, profileId, selector: catalog.profile(profileId).selector, inference: catalog.profile(profileId).inference, recovered }, audits,
        records: value.records.map(row => ({ ...row, evidence: row.evidence.map(ref => { const paragraph = byId.get(ref.paragraph)!; return { paragraphId: paragraph.id, chapterId: paragraph.chapterId, start: paragraph.start, end: paragraph.end, chapterSha256: sourceRows.get(paragraph.chapterId)!.sha256, anchorSha256: paragraph.sha256 }; }) })) });
      completed++; process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "regional-preliminary-opinions", tasks: tasks.length, deferred: value.records.filter(row => row.recommendation === "defer").length, recovered })}\n`);
    };
    if (draft) { try { finish(validateRegionalProposal(schema.parse(draft), tasks, paragraphs, targetIds, moduleIds), true); return; } catch (error) { problems = sourceValidationDiagnostics(error, draft); } }
    const offset = old.length ? parseInt(old.at(-1)!) + 1 : 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const storedAttempt = offset + attempt;
      try {
        const dispatch = await sourceRunnerCallIfActive(() => draining, () => gateway.generateStructured({ profileId, role: "creation", subjectId: batch.id, workloadId: "fanren-regional-proposals", batchId: `${batch.id}-regions-${storedAttempt}`,
          promptVersion: `fanren-regional-proposals-${policyHash}`, schemaName: "fanren_regional_proposals", system,
          userPrompt: `复核全部 ${tasks.length} 组地区与候选编号，输出完整初审意见。${draft ? "按列明的具体问题修正全部记录，不删条目。" : "先对照原文，再判断区域归属与当前档案。"}`,
          context: { paragraphs, taskManifest: tasks, candidates, ...(editorialFindings.length ? { editorialFindings } : {}), sourceAdjudication: { records: adjudication.records, aliases: adjudication.aliases, issues: adjudication.issues, omissions: adjudication.omissions, identities: adjudication.identities }, openingModule: openingSnapshot, modules, targetCatalog, ...(draft ? { draft, problems } : {}) }, schema,
          runtimeIdentity: { worldHash: `sha256:${identity}`, revision: 0 }, jsonExamplePolicy: "omit", structuredOutputMode: "json-object-zod" }));
        if (dispatch.status === "stopped") {
          process.stdout.write(`${JSON.stringify({ batch: batch.id, status: "stopped-before-paid-repair", storedAttempt })}\n`);
          return;
        }
        const result = dispatch.value;
        draft = result.value; audits.push(result.audit); save(path.join(directory, `${storedAttempt}.json`), { identity, bindings, value: draft, audit: result.audit });
      } catch (error) {
        if (!(error instanceof ModelOutputError) || error.rawValue === undefined) throw error;
        draft = error.rawValue; audits.push(error.audit); save(path.join(directory, `${storedAttempt}.json`), { identity, bindings, value: draft, audit: error.audit, rejected: true });
      }
      try { finish(validateRegionalProposal(schema.parse(draft), tasks, paragraphs, targetIds, moduleIds), false); return; }
      catch (error) { problems = sourceValidationDiagnostics(error, draft); if (attempt === 2) throw error; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, async () => { while (!draining && next < batches.length) {
    const batch = batches[next++]!;
    try { await processBatch(batch); } catch (error) {
      failed++; const block = sourceRunnerAccountBlock(error); if (block) draining = true;
      const record = { batch: batch.id, status: "regional-proposal-failed", failureKind: block ?? "validation-or-runtime", message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
      save(path.join(cache, "regional-proposals", "failures", `${batch.id}-${Date.now()}.json`), record); process.stderr.write(`${JSON.stringify(record)}\n`);
    }
  } }));
  process.stdout.write(`${JSON.stringify({ status: draining ? "drained" : "finished", completed, failed, waiting, concurrency, accountConcurrency })}\n`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
