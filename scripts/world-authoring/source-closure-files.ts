import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { candidateEditorialTargets, type CandidateQueue } from "./candidate-dispositions";
import { validateSourceClosure, type SourceClosureContext } from "./source-closure";
import type { ReadingBatch } from "./authoring-index";
import type { SourceParagraph } from "./extraction-contract";

export interface SourceClosureFileOptions { root?: string; sourceCache?: string; globalManifest?: string }

export function loadSourceClosureContext(options: SourceClosureFileOptions = {}): SourceClosureContext {
  const root = path.resolve(options.root ?? "worlds/fanren/authoring");
  const cache = path.resolve(options.sourceCache ?? ".livingworld-cache/fanren-sources");
  const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
  const readLocal = (file: string) => read(path.join(root, file));
  const chapters = readFileSync(path.join(root, "coverage/chapters.jsonl"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line)) as Array<{ id: string; characters: number; sha256: string; source_version?: string }>;
  const bodies = new Map<string, string>();
  const readChapter = (id: string) => {
    if (!/^qq-\d+$/u.test(id)) throw new Error(`invalid chapter identity ${id}`);
    if (!bodies.has(id)) bodies.set(id, readFileSync(path.join(cache, "chapters", `${id}.txt`), "utf8"));
    return bodies.get(id)!;
  };
  const loadReports = (folder: string) => new Map(readdirSync(path.join(root, folder)).filter(file => /^batch-\d+\.json$/u.test(file)).sort()
    .map(file => [file.slice(0, -5), readLocal(`${folder}/${file}`)]));
  const folders = readdirSync(path.join(root, "regions"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const optional = (file: string, fallback: unknown) => existsSync(path.join(root, file)) ? readLocal(file) : fallback;
  const targets = candidateEditorialTargets(readLocal("modules/opening-sample.json"), readLocal("claims/opening-sample.json"), folders.map(id => ({ id,
    module: optional(`regions/${id}/module.json`, { entities: [] }), claims: optional(`regions/${id}/claims.json`, []),
    subjects: optional(`regions/${id}/subjects.json`, []) })));
  // The full base may replace the sample at build time; both are explicit authoring targets.
  if (existsSync(path.join(root, "modules/full-world.json"))) {
    const baseTargets = candidateEditorialTargets(readLocal("modules/full-world.json"), readLocal("claims/full-world.json"), []);
    for (const target of baseTargets) targets.add(target);
  }
  const dispositions: SourceClosureContext["dispositions"] = folders.filter(id => existsSync(path.join(root, `regions/${id}/candidate-dispositions.json`)))
    .map(id => ({ path: `regions/${id}/candidate-dispositions.json`, report: readLocal(`regions/${id}/candidate-dispositions.json`),
      queuePath: `coverage/regional-queues/${id}.json`, queue: readLocal(`coverage/regional-queues/${id}.json`) as CandidateQueue }));
  // Manifest paths are repository-relative and explicit; no ignored directory is silently trusted.
  const manifest = options.globalManifest;
  const inputArtifacts: NonNullable<SourceClosureContext["inputArtifacts"]> = [];
  if (manifest) {
    const manifestValue = read(path.resolve(manifest));
    inputArtifacts.push({ path: path.relative(process.cwd(), path.resolve(manifest)), value: manifestValue });
    const units = z.array(z.object({ report: z.string().min(1), queue: z.string().min(1),
      proofs: z.array(z.object({ path: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/u) }))
        .min(1, "global manifest unit needs proof evidence"),
    }).passthrough()).parse(manifestValue);
    const proofPaths = new Set<string>();
    for (const unit of units) {
      dispositions.push({ path: unit.report, report: read(path.resolve(unit.report)),
        queuePath: unit.queue, queue: read(path.resolve(unit.queue)) as CandidateQueue });
      for (const proof of unit.proofs) {
        const proofPath = path.relative(process.cwd(), path.resolve(proof.path)), value = read(path.resolve(proof.path));
        if (contentHash(value) !== proof.contentHash) throw new Error(`global proof fingerprint drift ${proof.path}`);
        if (!proofPaths.has(proofPath)) inputArtifacts.push({ path: proofPath, value });
        proofPaths.add(proofPath);
      }
    }
  }
  const context: SourceClosureContext = { inputArtifacts, chapters, batches: readLocal("coverage/batches.json") as ReadingBatch[],
    extractions: loadReports("extractions"), adjudications: loadReports("adjudications"), readChapter, targetIds: targets, dispositions,
    readArtifact: file => read(path.resolve(file)),
    resolutions: readdirSync(path.join(root, "reviews")).filter(file => /^source-.*-resolutions\.json$/u.test(file)).sort()
      .map(file => ({ path: `reviews/${file}`, report: readLocal(`reviews/${file}`) })),
    recoveryAccess: batch => {
      const paragraphs: SourceParagraph[] = [];
      for (const part of batch.parts) {
        let offset = part.start;
        for (const text of [...readChapter(part.chapter_id)].slice(part.start, part.end).join("").split("\n")) {
          const end = offset + [...text].length;
          if (text.trim()) paragraphs.push({ id: `${part.chapter_id}:${offset}`, chapterId: part.chapter_id, text,
            start: offset, end, sha256: contentHash(text), sourceVersion: chapters.find(row => row.id === part.chapter_id)?.source_version });
          offset = end + 1;
        }
      }
      return { paragraphs, readAttempt: (identity, attempt) => read(path.join(cache, "adjudications", batch.id, identity, `${attempt}.json`)) };
    },
  };
  return context;
}

/** Production full builds require this current evidence, not saved coverage booleans. */
export function assertFullSourceClosure(options: Omit<SourceClosureFileOptions, "globalManifest"> = {}) {
  const root = path.resolve(options.root ?? "worlds/fanren/authoring");
  const report = path.join(root, "coverage/source-closure.json");
  const manifest = path.join(root, "reviews/global-candidate-manifest.json");
  if (!existsSync(report) || !existsSync(manifest)) throw new Error("full build requires the source closure report and global candidate manifest");
  const result = validateSourceClosure(JSON.parse(readFileSync(report, "utf8")), loadSourceClosureContext({ ...options, globalManifest: manifest }));
  if (!result.passed) throw new Error("full build requires complete source, semantic and candidate closure");
  return result;
}
