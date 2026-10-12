import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { type JsonValue } from "../runtime/json";
import { admitProgram, bindProgram, programDefinitionSchema, programHash, type AdmittedProgram, type ProgramAdmission, type ProgramResources } from "./definition";
import { type ProgramCompilationResult } from "./compiler";
import { type ProgramInterpreter } from "./interpreter";

const entrySchema = z.object({ program: z.object({ definition: programDefinitionSchema, sourceHashes: z.record(z.string(), programHash),
  hash: programHash, admissionHash: programHash }).strict(), parameters: z.record(z.string(), z.json()), sourceHash: programHash,
  creationInvocationIds: z.array(z.string().min(1)).min(1) }).strict();
export type ProgramLibraryEntry = z.infer<typeof entrySchema>;
const snapshotSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema), hash: programHash }).strict();
export interface GoalProgramCoverage {
  ownerId: string;
  goalId: string;
  status: "completed" | "startable" | "waiting" | "needs-generation" | "needs-decision";
  programHashes: string[];
  reasons: string[];
}

/** Private plans have an owner namespace. World rule programs use a separate library and context boundary. */
export class ProgramLibrary {
  private readonly entries = new Map<string, ProgramLibraryEntry>();
  constructor(snapshot?: unknown) {
    if (snapshot !== undefined) {
      const { hash, ...value } = snapshotSchema.parse(snapshot);
      if (contentHash(value) !== hash) throw new Error("program library checksum mismatch");
      for (const entry of value.entries) {
        if (this.entries.has(entry.program.hash)) throw new Error("duplicate library program");
        this.assertHash(entry.program);
        this.entries.set(entry.program.hash, structuredClone(entry));
      }
    }
  }
  private assertHash(program: AdmittedProgram) {
    if (contentHash({ definition: program.definition, sourceHashes: program.sourceHashes }) !== program.hash) throw new Error("library program hash mismatch");
  }
  add(result: Extract<ProgramCompilationResult, { status: "ready" }>) {
    this.assertHash(result.program);
    const entry = entrySchema.parse({ program: result.program, parameters: result.parameters, sourceHash: result.sourceHash,
      creationInvocationIds: result.audit.invocations.map(invocation => invocation.id) });
    const existing = this.entries.get(entry.program.hash);
    if (existing && contentHash(existing.program) !== contentHash(entry.program)) throw new Error("immutable library program collision");
    if (!existing) this.entries.set(entry.program.hash, entry);
  }
  forOwner(ownerId: string): ProgramLibraryEntry[] {
    return [...this.entries.values()].filter(entry => entry.program.definition.owner.agentId === ownerId).map(entry => structuredClone(entry));
  }
  get(ownerId: string, hash: string, admission: ProgramAdmission, entityIds: ReadonlySet<string>, parameters?: Record<string, JsonValue>) {
    const entry = this.entries.get(hash);
    if (!entry || entry.program.definition.owner.agentId !== ownerId || admission.ownerId !== ownerId) throw new Error("private program is unavailable to this owner");
    const current = admitProgram(entry.program.definition, admission);
    if (current.hash !== hash) throw new Error("program sources changed; compile a new immutable definition");
    return { program: structuredClone(entry.program), parameters: bindProgram(entry.program, parameters ?? entry.parameters, entityIds) };
  }
  coverage(ownerId: string, goalIds: readonly string[], interpreters: readonly ProgramInterpreter[], resources: ProgramResources, atSeconds: number): GoalProgramCoverage[] {
    const entries = this.forOwner(ownerId);
    return goalIds.map(goalId => {
      const matching = entries.filter(entry => entry.program.definition.goals.some(goal => goal.goalId === goalId));
      const instances = interpreters.filter(interpreter => interpreter.program.definition.owner.agentId === ownerId &&
        matching.some(entry => entry.program.hash === interpreter.program.hash));
      const startable = instances.some(interpreter => interpreter.work(resources, atSeconds).some(work => work.kind === "attempt" || work.kind === "utterance"));
      const needsDecision = instances.some(interpreter => interpreter.work(resources, atSeconds).some(work => work.kind === "predicate"));
      const waiting = instances.some(interpreter => interpreter.status !== "needs-expansion" && interpreter.status !== "ended" &&
        !interpreter.work(resources, atSeconds).length && interpreter.subscriptions(resources, atSeconds).reason !== "no-progress");
      return { ownerId, goalId, status: instances.some(interpreter => interpreter.completion.goals[goalId]) ? "completed" : startable ? "startable" : needsDecision ? "needs-decision" : waiting ? "waiting" : "needs-generation",
        programHashes: matching.map(entry => entry.program.hash), reasons: instances.map(interpreter => interpreter.completion.expansionReason ??
          (interpreter.status === "ended" && !interpreter.completion.goals[goalId] ? "program-ended-without-goal-evidence"
            : interpreter.subscriptions(resources, atSeconds).reason)) };
    });
  }
  snapshot() {
    const value = { version: 1 as const, entries: [...this.entries.values()].sort((a, b) => a.program.hash.localeCompare(b.program.hash)) };
    return structuredClone({ ...value, hash: contentHash(value) });
  }
}
