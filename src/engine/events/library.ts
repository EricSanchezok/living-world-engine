import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { programHash, type ProgramResources } from "../programs/definition";
import type { JsonValue } from "../runtime/json";
import type { BoundWorldProgram, WorldAttempt } from "./adjudication";
import type { WorldCompilation } from "./compiler";
import { captureReads } from "./resources";
import { admitWorldProgram, bindWorldProgram, renderWorldText, worldProgramSchema } from "./world-program";

const entrySchema = z.object({ signature: programHash, definition: worldProgramSchema, sourceHashes: z.record(z.string(), programHash),
  programHash, parameters: z.record(z.string(), z.json()), compilerSourceHash: programHash, invocationIds: z.array(z.string()).min(1) }).strict();
const snapshotSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema), hash: programHash }).strict();
type Entry = z.infer<typeof entrySchema>;

/** Reuses exact intent bindings. Broader semantic selection may propose a candidate, but cannot bypass execution adjudication. */
export class WorldProgramLibrary {
  private readonly entries = new Map<string, Entry>();
  constructor(snapshot?: unknown) {
    if (snapshot !== undefined) {
      const { hash, ...value } = snapshotSchema.parse(snapshot);
      if (hash !== contentHash(value)) throw new Error("world library checksum mismatch");
      for (const entry of value.entries) {
        if (contentHash({ definition: entry.definition, sourceHashes: entry.sourceHashes }) !== entry.programHash || this.entries.has(entry.signature)) throw new Error("invalid world library entry");
        this.entries.set(entry.signature, entry);
      }
    }
  }
  private signature(attempt: WorldAttempt) {
    return contentHash({ actorEntityId: attempt.actorEntityId, targets: attempt.targetEntityIds,
      origin: attempt.program ? { definitionHash: attempt.program.definitionHash, nodeId: attempt.program.nodeId,
        parameterHash: attempt.program.parameterHash, intent: attempt.intent, hasSpeech: attempt.utterance !== null }
        : { intent: attempt.intent, utterance: attempt.utterance } });
  }
  add(compilation: Extract<WorldCompilation, { status: "ready" }>) {
    const bound = compilation.bound;
    const entry = entrySchema.parse({ signature: this.signature(bound.attempt), definition: bound.program.definition, sourceHashes: bound.program.sourceHashes,
      programHash: bound.program.hash, parameters: bound.parameters, compilerSourceHash: compilation.sourceHash,
      invocationIds: compilation.audit.invocations.map(invocation => invocation.id) });
    this.entries.set(entry.signature, structuredClone(entry));
  }
  lookup(attempt: WorldAttempt, sources: Record<string, JsonValue>, entities: ReadonlySet<string>, resources: ProgramResources): BoundWorldProgram | null {
    const entry = this.entries.get(this.signature(attempt)); if (!entry) return null;
    if (Object.entries(entry.sourceHashes).some(([id, hash]) => !Object.hasOwn(sources, id) || contentHash(sources[id]) !== hash)) return null;
    const program = admitWorldProgram(entry.definition, sources);
    if (program.hash !== entry.programHash) return null;
    const parameters = structuredClone(entry.parameters);
    if (attempt.utterance !== null && program.definition.parameters.utterance?.kind === "text") parameters.utterance = attempt.utterance;
    bindWorldProgram(program, parameters, entities);
    captureReads(resources, program.definition.reads.filter(key => !/^(random|check):/u.test(key)).map(key => renderWorldText(key, parameters)));
    return { program, parameters, attempt: structuredClone(attempt) };
  }
  snapshot() {
    const value = { version: 1 as const, entries: [...this.entries.values()].sort((a, b) => a.signature.localeCompare(b.signature)) };
    return structuredClone({ ...value, hash: contentHash(value) });
  }
}
