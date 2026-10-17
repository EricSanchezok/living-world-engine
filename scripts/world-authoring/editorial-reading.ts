import { contentHash } from "../../src/engine/models/model-audit";

type Entry = { chapterId?: unknown; sha256?: unknown; characters?: unknown; firstPass?: unknown; read?: unknown; secondPass?: unknown };
type Report = { sourceReads?: Entry[]; groups?: Array<{ parts?: Entry[] }>; additionalReadChapters?: unknown[] };
export type EditorialReadingInput = { moduleId: string; file: string; report: Report };

/** Editorial attestations remain distinct from model input evidence and fact approval. */
export function indexEditorialReading(inputs: EditorialReadingInput[], body: (chapterId: string) => string) {
  const entries: Array<{ moduleId: string; file: string; reportSha256: string; chapterId: string;
    chapterSha256: string; characters: number; start: 0; end: number; firstPass: string; secondPass: string | null;
    status: "fingerprint-bound-editorial-reading-attestation"; approvedForRuntime: false }> = [];
  const invalid: Array<{ moduleId: string; file: string; chapterId: string | null; message: string }> = [];
  const unbound: Array<{ moduleId: string; file: string; chapterId: string; status: "reading-mentioned-without-version-fingerprint" }> = [];
  for (const input of inputs) {
    const reportSha256 = contentHash(input.report);
    const records = [...(input.report.sourceReads ?? []), ...(input.report.groups ?? []).flatMap(group => group.parts ?? [])];
    const boundIds = new Set<string>();
    for (const record of records) {
      try {
        if (typeof record.chapterId !== "string" || !/^qq-\d+$/u.test(record.chapterId)) throw new Error("Missing stable chapter identity");
        if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)) throw new Error("Missing reading-version fingerprint");
        const firstPass = record.firstPass ?? record.read;
        if (typeof firstPass !== "string" || !firstPass.trim()) throw new Error("Missing first-pass reading attestation");
        const text = body(record.chapterId), characters = [...text].length;
        if (contentHash(text) !== record.sha256) throw new Error("Reading-version fingerprint differs from current source");
        if (record.characters !== undefined && record.characters !== characters) throw new Error("Reading character count differs from current source");
        if (boundIds.has(record.chapterId)) throw new Error("Duplicate chapter reading entry in the same module");
        boundIds.add(record.chapterId);
        entries.push({ moduleId: input.moduleId, file: input.file, reportSha256, chapterId: record.chapterId,
          chapterSha256: record.sha256, characters, start: 0, end: characters, firstPass,
          secondPass: typeof record.secondPass === "string" ? record.secondPass : null,
          status: "fingerprint-bound-editorial-reading-attestation", approvedForRuntime: false });
      } catch (error) {
        invalid.push({ moduleId: input.moduleId, file: input.file, chapterId: typeof record.chapterId === "string" ? record.chapterId : null,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const chapterId of input.report.additionalReadChapters ?? []) {
      if (typeof chapterId === "string" && !boundIds.has(chapterId)) unbound.push({ moduleId: input.moduleId,
        file: input.file, chapterId, status: "reading-mentioned-without-version-fingerprint" });
    }
  }
  return { entries, invalid, unbound, uniqueFingerprintBoundChapters: new Set(entries.map(entry => entry.chapterId)).size };
}
