import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../../src/engine/models/model-audit";
import { routeRegionalCandidates } from "./regional-work";

const root = path.resolve("worlds/fanren/authoring");
const cache = path.resolve(".livingworld-cache/fanren-sources");
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const chapters = new Map<string, { sha256: string }>(readFileSync(path.join(root, "coverage/chapters.jsonl"), "utf8").trim().split("\n").map(line => {
  const chapter = JSON.parse(line); return [chapter.id, chapter];
}));
const bodies = new Map<string, string>();
function body(id: string) {
  if (!/^qq-\d+$/u.test(id) || !chapters.has(id)) throw new Error(`unknown chapter ${id}`);
  if (!bodies.has(id)) {
    const source = readFileSync(path.join(cache, "chapters", `${id}.txt`), "utf8");
    if (contentHash(source) !== chapters.get(id)!.sha256) throw new Error(`source baseline drift ${id}`);
    bodies.set(id, source);
  }
  return bodies.get(id)!;
}
const reports = readdirSync(path.join(root, "extractions")).filter(file => /^batch-\d+\.json$/u.test(file)).sort().map(file => read(`extractions/${file}`));
const result = routeRegionalCandidates(reports, read("coverage/regional-plan.json").modules, read("coverage/batches.json"), body);
const directory = path.join(root, "coverage", "regional-queues");
mkdirSync(directory, { recursive: true });
function save(name: string, value: unknown) {
  const destination = path.join(directory, `${name}.json`);
  writeFileSync(`${destination}.tmp`, `${JSON.stringify(value, null, 2)}\n`); renameSync(`${destination}.tmp`, destination);
}
for (const queue of result.queues) save(queue.moduleId, { formatVersion: result.formatVersion, inputHash: result.inputHash, ...queue });
save("unassigned", { inputHash: result.inputHash, status: "requires-editorial-routing", candidates: result.unassigned });
save("status", { inputHash: result.inputHash, sourceBatchIds: result.sourceBatchIds,
  modules: result.queues.map(queue => ({ id: queue.moduleId, candidateCount: queue.candidates.length })),
  unassignedCandidates: result.unassigned.length, note: result.note });
process.stdout.write(`${JSON.stringify({ batches: reports.length, regions: result.queues.length, unassigned: result.unassigned.length })}\n`);
