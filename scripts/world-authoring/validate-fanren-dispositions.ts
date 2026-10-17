import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { validateCandidateDispositions, type CandidateQueue } from "./candidate-dispositions";

const root = path.resolve("worlds/fanren/authoring");
const regionRoot = path.join(root, "regions");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const folders = readdirSync(regionRoot, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name);
const targets = new Set<string>();
for (const folder of folders) {
  targets.add(folder);
  for (const filename of ["module.json", "claims.json", "subjects.json"]) {
    const file = path.join(regionRoot, folder, filename);
    if (!existsSync(file)) continue;
    const document = read(file);
    const records = Array.isArray(document) ? document : document.entities ?? [];
    for (const item of records) if (typeof item.id === "string") targets.add(item.id);
  }
}
const reports = new Map<string, unknown>();
for (const filename of readdirSync(path.join(root, "extractions")).filter(file => /^batch-\d+\.json$/.test(file))) {
  reports.set(filename.slice(0, -5), read(path.join(root, "extractions", filename)));
}
const requested = process.argv.slice(2);
const selected = requested.length ? requested : folders.filter(folder => existsSync(path.join(regionRoot, folder, "candidate-dispositions.json")));
if (!selected.length) throw new Error("no candidate disposition reports found");
for (const folder of selected) {
  if (!folders.includes(folder)) throw new Error(`unknown region ${folder}`);
  const result = validateCandidateDispositions(read(path.join(regionRoot, folder, "candidate-dispositions.json")),
    read(path.join(root, "coverage", "regional-queues", `${folder}.json`)) as CandidateQueue,
    { reports, targetIds: targets, readChapter: id => {
      if (!/^qq-\d+$/.test(id)) throw new Error(`invalid chapter identity ${id}`);
      return readFileSync(path.resolve(".livingworld-cache/fanren-sources/chapters", `${id}.txt`), "utf8");
    } });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
