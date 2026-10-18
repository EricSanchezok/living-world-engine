import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSourceClosure, validateSourceClosure } from "./source-closure";
import { loadSourceClosureContext } from "./source-closure-files";

const args = process.argv.slice(2);
const option = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const context = loadSourceClosureContext({ root: option("--root"), sourceCache: option("--source-cache"), globalManifest: option("--global-manifest") });
const saved = option("--validate"), output = option("--output");
if (saved) {
  const result = validateSourceClosure(read(path.resolve(saved)), context);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 2;
} else {
  const result = buildSourceClosure(context);
  if (output) writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.status, inputHash: result.inputHash, counts: result.counts,
    sourceComplete: result.sourceComplete, semanticComplete: result.semanticComplete, candidateComplete: result.candidateComplete,
    residual: Object.fromEntries(Object.entries(result.residual).map(([key, value]) => [key, value.length])) })}\n`);
  if (!result.sourceComplete || !result.semanticComplete || !result.candidateComplete) process.exitCode = 2;
}
