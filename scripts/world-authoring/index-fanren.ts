import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../../src/engine/models/model-audit";
import { fullyExtractedChapters, indexSourceReports, type ReadingBatch } from "./authoring-index";
import { buildSourceAdjudicationEvidence, buildSourceReadingEvidence } from "./source-evidence";
import { indexEditorialReading } from "./editorial-reading";

const root = path.resolve("worlds/fanren/authoring");
const cache = path.resolve(".livingworld-cache/fanren-sources/chapters");
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const save = (file: string, value: unknown) => writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
const saveLines = (file: string, value: unknown[]) => writeFileSync(path.join(root, file), value.map(row => JSON.stringify(row)).join("\n") + "\n");
const chapters = readFileSync(path.join(root, "coverage/chapters.jsonl"), "utf8").trim().split("\n")
  .map(line => JSON.parse(line)) as Array<{ id: string; characters: number; sha256: string; read: boolean; extracted: boolean; reviewed: boolean }>;
const chapterMap = new Map(chapters.map(chapter => [chapter.id, chapter]));
const bodies = new Map<string, string>();
function body(id: string) {
  const chapter = chapterMap.get(id);
  if (!chapter || !/^qq-\d+$/u.test(id)) throw new Error(`unknown source chapter ${id}`);
  if (!bodies.has(id)) {
    const text = readFileSync(path.join(cache, `${id}.txt`), "utf8");
    if (contentHash(text) !== chapter.sha256 || [...text].length !== chapter.characters) throw new Error(`chapter baseline drift ${id}`);
    bodies.set(id, text);
  }
  return bodies.get(id)!;
}
const batches = read("coverage/batches.json") as Array<ReadingBatch & { extracted: boolean }>;
const inputs = readdirSync(path.join(root, "extractions")).filter(file => /^batch-\d+\.json$/u.test(file)).sort()
  .map(file => read(`extractions/${file}`));
const index = indexSourceReports(inputs, batches, body);
const inputsByBatch = new Map(inputs.map(input => [input.batchId as string, input]));
const readingEvidence: Array<ReturnType<typeof buildSourceReadingEvidence>> = [];
const adjudicationEvidence: Array<ReturnType<typeof buildSourceAdjudicationEvidence>> = [];
const invalidAdjudications: Array<{ batchId: string; status: "invalid-source-adjudication-evidence"; message: string; approvedForRuntime: false }> = [];
for (const batch of batches) {
  const input = inputsByBatch.get(batch.id);
  if (!input) continue;
  readingEvidence.push(buildSourceReadingEvidence(input, batch, body));
  const file = `adjudications/${batch.id}.json`;
  if (!existsSync(path.join(root, file))) continue;
  try { adjudicationEvidence.push(buildSourceAdjudicationEvidence(read(file), input, batch, body)); }
  catch (error) { invalidAdjudications.push({ batchId: batch.id, status: "invalid-source-adjudication-evidence",
    message: error instanceof Error ? error.message : String(error), approvedForRuntime: false }); }
}
const readingByBatch = new Map(readingEvidence.map(row => [row.batchId, row]));
const adjudicationByBatch = new Map(adjudicationEvidence.map(row => [row.batchId, row]));
const invalidByBatch = new Map(invalidAdjudications.map(row => [row.batchId, row]));
const editorialReading = indexEditorialReading(readdirSync(path.join(root, "regions"), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(path.join(root, "regions", entry.name, "source-reading.json")))
  .sort((left, right) => left.name.localeCompare(right.name)).map(entry => {
    const file = `regions/${entry.name}/source-reading.json`;
    return { moduleId: entry.name, file, report: read(file) };
  }), body);
saveLines("coverage/editorial-source-reading.jsonl", editorialReading.entries);
saveLines("coverage/source-reading.jsonl", batches.map(batch => readingByBatch.get(batch.id) ?? {
  batchId: batch.id, status: "awaiting-source-extraction", sourceParts: batch.parts, approvedForRuntime: false }));
saveLines("coverage/source-adjudication.jsonl", batches.map(batch => adjudicationByBatch.get(batch.id) ?? invalidByBatch.get(batch.id) ?? {
  batchId: batch.id, status: readingByBatch.has(batch.id) ? "awaiting-independent-source-adjudication" : "awaiting-source-extraction",
  sourceParts: batch.parts, approvedForRuntime: false }));
const sourceEvidence = { format_version: 1, status: "source-evidence-not-editorial-approval", plannedBatches: batches.length,
  reading: { completeBatches: readingEvidence.length,
    fullyCoveredChapters: fullyExtractedChapters(batches, [...readingByBatch.keys()], chapters).size,
    missingBatchIds: batches.filter(batch => !readingByBatch.has(batch.id)).map(batch => batch.id),
    residualSourceIssues: readingEvidence.reduce((sum, row) => sum + row.residualSourceIssues, 0) },
  adjudication: { completeBatches: adjudicationEvidence.length,
    fullyCoveredChapters: fullyExtractedChapters(batches, [...adjudicationByBatch.keys()], chapters).size,
    missingBatchIds: batches.filter(batch => !adjudicationByBatch.has(batch.id)).map(batch => batch.id),
    invalidReports: invalidAdjudications,
    judgments: { supported: adjudicationEvidence.reduce((sum, row) => sum + row.judgments.supported, 0),
      unsupported: adjudicationEvidence.reduce((sum, row) => sum + row.judgments.unsupported, 0),
      ambiguous: adjudicationEvidence.reduce((sum, row) => sum + row.judgments.ambiguous, 0) },
    residual: { unresolvedAliases: adjudicationEvidence.reduce((sum, row) => sum + row.residual.unresolvedAliases, 0),
      unresolvedIssues: adjudicationEvidence.reduce((sum, row) => sum + row.residual.unresolvedIssues, 0),
      unresolvedIdentities: adjudicationEvidence.reduce((sum, row) => sum + row.residual.unresolvedIdentities, 0),
      omissions: adjudicationEvidence.reduce((sum, row) => sum + row.residual.omissions, 0) } },
  editorialReading: { fingerprintBoundEntries: editorialReading.entries.length,
    uniqueFingerprintBoundChapters: editorialReading.uniqueFingerprintBoundChapters,
    invalidEntries: editorialReading.invalid, unboundMentions: editorialReading.unbound },
  note: "完整输入、模型裁决与编辑直接阅读声明分别记录；指纹验证绑定所读版本，不将所用锚点二读等同全章事实审定。均不改变 read/reviewed，也不授予开篇事实或运行批准。剩余问题须由具体编辑处置解决。" };
save("coverage/source-status.json", sourceEvidence);
const regions = read("coverage/regional-plan.json") as { modules: Array<{ id: string; realm: string; search_terms: string[] }> };
const mentions = regions.modules.map(region => ({ moduleId: region.id, status: "lexical-leads-not-reviewed-facts",
  terms: region.search_terms.map(term => {
    const hits: Array<{ chapterId: string; chapterSha256: string; start: number; end: number; anchorSha256: string }> = [];
    for (const chapter of chapters) {
      const text = body(chapter.id), offset = text.indexOf(term);
      if (offset < 0) continue;
      const start = [...text.slice(0, offset)].length;
      hits.push({ chapterId: chapter.id, chapterSha256: chapter.sha256, start, end: start + [...term].length, anchorSha256: contentHash(term) });
    }
    return { term, matchingChapters: hits.length, firstLocators: hits.slice(0, 3), status: hits.length ? "unread-context" : "query-not-found-requires-triage" };
  }) }));

mkdirSync(path.join(root, "index"), { recursive: true });
saveLines("index/subjects.jsonl", index.subjects);
saveLines("index/fact-references.jsonl", index.facts);
saveLines("index/issue-references.jsonl", index.issues);
save("index/name-candidates.json", index.names);
save("index/region-mentions.json", mentions);
const extracted = fullyExtractedChapters(batches, index.acceptedBatchIds, chapters);
for (const chapter of chapters) chapter.extracted = extracted.has(chapter.id);
for (const batch of batches) batch.extracted = index.acceptedBatchIds.includes(batch.id);
saveLines("coverage/chapters.jsonl", chapters);
save("coverage/batches.json", batches);
const summary = { format_version: 1, status: "provisional-not-canonical", acceptedBatchIds: index.acceptedBatchIds,
  mainChapters: chapters.length, fullyExtractedChapters: extracted.size, readChapters: chapters.filter(chapter => chapter.read).length,
  reviewedChapters: chapters.filter(chapter => chapter.reviewed).length, candidateSubjects: index.subjects.length,
  sourceReadingBatches: readingEvidence.length, sourceAdjudicationBatches: adjudicationEvidence.length,
  invalidSourceAdjudications: invalidAdjudications.length,
  editorialReadingChapters: editorialReading.uniqueFingerprintBoundChapters,
  invalidEditorialReadingEntries: editorialReading.invalid.length,
  candidateFacts: index.facts.length, issues: index.issues.length, canonicalSubjects: 0,
  namesWithMultipleCandidates: index.names.filter(name => name.candidateIds.length > 1).length,
  regionalModules: regions.modules.length, regionQueriesNotFound: mentions.flatMap(region => region.terms.filter(term => term.matchingChapters === 0).map(term => ({ moduleId: region.moduleId, term: term.term }))),
  note: "文本检索不计作通读或复核；相同名称仅聚为待核候选。全文事实与候选描述只保存在所属提取批次中，索引保存身份和指纹引用。" };
save("index/status.json", summary);
process.stdout.write(`${JSON.stringify(summary)}\n`);
