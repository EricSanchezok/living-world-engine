import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { assertJsonValue, type JsonValue } from "../runtime/json";
import { bindProgram, evaluateExpression, programHash, programKey, type AdmittedProgram, type ProgramNode,
  type ProgramPredicate, type ProgramResources } from "./definition";

const ordinal = z.number().int().nonnegative().safe();
export const programReceiptSchema = z.object({
  id: programHash, instanceId: programKey, workId: programHash, requestHash: programHash,
  status: z.enum(["succeeded", "partial", "failed", "blocked", "cancelled"]),
  eventIds: z.array(z.string().min(1)), effectHash: programHash, madeProgress: z.boolean(),
  atSeconds: ordinal,
}).strict();
export type ProgramReceipt = z.infer<typeof programReceiptSchema>;
type Verdict = "yes" | "no" | "unknown";
type Leaf = { kind: "leaf"; nodeId: string; activation: number; atSeconds: number | null; issued: string | null;
  lastInputHash: string | null; utterance: string | null };
type Residual = Leaf | { kind: "done"; nodeId: string }
  | { kind: "sequence"; nodeId: string; children: Residual[] }
  | { kind: "parallel"; nodeId: string; children: Residual[] }
  | { kind: "branch"; nodeId: string; child: Residual }
  | { kind: "repeat-body"; nodeId: string; child: Residual };
export interface ProgramPredicateWork {
  kind: "predicate";
  id: string;
  predicateId: string;
  reason: "start" | "flow" | "interrupt" | "milestone" | "goal";
  subjectId: string;
  inputHash: string;
  dependencies: Record<string, number>;
  state: Record<string, { version: number; value: JsonValue }>;
  mechanicalVerdict: Verdict | null;
}
export interface ProgramAttemptWork {
  kind: "attempt" | "utterance" | "deadline";
  id: string;
  nodeId: string;
  inputHash: string;
  intent: string;
  targetIds: string[];
  utterance: string | null;
}
export type ProgramWork = ProgramPredicateWork | ProgramAttemptWork;
const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("predicate"), ticket: programHash, predicateId: programKey,
    reason: z.enum(["start", "flow", "interrupt", "milestone", "goal"]), subjectId: z.string().min(1),
    inputHash: programHash, verdict: z.enum(["yes", "no", "unknown"]), evidenceHash: programHash, atSeconds: ordinal }).strict(),
  z.object({ kind: z.literal("issue"), workId: programHash, requestHash: programHash, atSeconds: ordinal }).strict(),
  z.object({ kind: z.literal("utterance"), workId: programHash, text: z.string().trim().min(1), atSeconds: ordinal }).strict(),
  z.object({ kind: z.literal("settle"), receipt: programReceiptSchema, waitInputHash: programHash }).strict(),
  z.object({ kind: z.literal("interrupt"), reason: z.string().min(1), atSeconds: ordinal }).strict(),
  z.object({ kind: z.literal("resume"), atSeconds: ordinal }).strict(),
  z.object({ kind: z.literal("deadline"), workId: programHash, atSeconds: ordinal }).strict(),
]);
type JournalEvent = z.infer<typeof eventSchema>;
const snapshotSchema = z.object({ version: z.literal(1), instanceId: programKey, definitionHash: programHash,
  parameters: z.record(programKey, z.json()), startedAtSeconds: ordinal, events: z.array(eventSchema), hash: programHash }).strict();
export type ProgramInstance = z.infer<typeof snapshotSchema>;

/** Persistent control flow. Only canonical receipts may settle attempts; this class never mutates world state. */
export class ProgramInterpreter {
  private readonly nodes: Map<string, ProgramNode>;
  private readonly predicates: Map<string, ProgramPredicate>;
  private readonly parameters: Readonly<Record<string, JsonValue>>;
  private readonly events: JournalEvent[] = [];
  private readonly checked = new Map<string, string>();
  private readonly seenFlow = new Map<string, number>();
  private readonly milestoneEvidence = new Map<string, string>();
  private readonly goalEvidence = new Map<string, string>();
  private readonly settledReceipts = new Set<string>();
  private root: Residual;
  private activation = 0;
  private progress = 0;
  private now: number;
  private paused = false;
  private started = false;
  private expansion: string | null = null;

  constructor(readonly program: AdmittedProgram, readonly instanceId: string, parameters: Record<string, JsonValue>,
    entityIds: ReadonlySet<string>, readonly startedAtSeconds = 0) {
    programKey.parse(instanceId); ordinal.parse(startedAtSeconds);
    this.parameters = bindProgram(program, parameters, entityIds);
    this.nodes = new Map(program.definition.nodes.map(node => [node.id, node]));
    this.predicates = new Map(program.definition.predicates.map(predicate => [predicate.id, predicate]));
    this.now = startedAtSeconds;
    this.root = this.normalize(this.activate(program.definition.entry));
  }

  static restore(input: unknown, program: AdmittedProgram, entityIds: ReadonlySet<string>, receipts: ReadonlyMap<string, ProgramReceipt>) {
    const value = snapshotSchema.parse(input), { hash, ...payload } = value;
    if (hash !== contentHash(payload) || program.hash !== value.definitionHash) throw new Error("program instance hash or version mismatch");
    const interpreter = new ProgramInterpreter(program, value.instanceId, value.parameters, entityIds, value.startedAtSeconds);
    for (const event of value.events) {
      if (event.kind === "settle" && contentHash(receipts.get(event.receipt.id) ?? null) !== contentHash(event.receipt)) {
        throw new Error("program settlement has no matching canonical receipt");
      }
      interpreter.apply(event);
    }
    return interpreter;
  }

  snapshot(): ProgramInstance {
    const payload = { version: 1 as const, instanceId: this.instanceId, definitionHash: this.program.hash,
      parameters: this.parameters, startedAtSeconds: this.startedAtSeconds, events: this.events };
    return snapshotSchema.parse({ ...payload, hash: contentHash(payload) });
  }

  get status() { return this.expansion ? "needs-expansion" : this.paused ? "interrupted" : !this.started ? "waiting" : this.root.kind === "done" ? "ended" : "running"; }
  get completion() {
    return { executionEnded: this.started && this.root.kind === "done", milestones: Object.fromEntries(this.milestoneEvidence),
      goals: Object.fromEntries(this.goalEvidence), expansionReason: this.expansion };
  }
  get parameterValues() { return structuredClone(this.parameters); }

  subscriptions(resources: ProgramResources, atSeconds: number) {
    const resourceKeys = new Set<string>(); const receiptWorkIds: string[] = []; const deadlines: number[] = [];
    let noProgress = false;
    for (const leaf of this.leaves()) {
      const node = this.nodes.get(leaf.nodeId)!;
      if (leaf.issued) receiptWorkIds.push(this.workId(leaf));
      if (node.kind === "attempt") this.program.definition.reads.forEach(key => resourceKeys.add(key));
      if (node.kind === "branch" || node.kind === "repeat" || node.kind === "wait") {
        const predicate = this.predicates.get(node.predicateId)!; predicate.reads.forEach(key => resourceKeys.add(key));
        const hash = this.project(predicate, resources).inputHash;
        if (node.kind === "repeat" && this.seenFlow.get(`${node.id}:${hash}`) === this.progress && !this.checked.has(`flow:${this.workId(leaf)}`)) noProgress = true;
        if (node.kind === "wait" && node.deadlineSeconds !== null && leaf.atSeconds! + node.deadlineSeconds > atSeconds) deadlines.push(leaf.atSeconds! + node.deadlineSeconds);
      }
    }
    const watched = [this.program.definition.startPredicateId, ...this.program.definition.interrupts,
      ...this.program.definition.milestones.filter(milestone => !this.milestoneEvidence.has(milestone.id)).map(milestone => milestone.predicateId),
      ...this.program.definition.goals.filter(goal => !this.goalEvidence.has(goal.goalId)).map(goal => goal.predicateId)];
    for (const id of watched) this.predicates.get(id)!.reads.forEach(key => resourceKeys.add(key));
    for (const goal of this.program.definition.goals) if (!this.goalEvidence.has(goal.goalId)) resourceKeys.add(`goal:${goal.goalId}`);
    return { resources: [...resourceKeys].sort(), receiptWorkIds, deadline: deadlines.length ? Math.min(...deadlines) : null,
      reason: noProgress ? "no-progress" : receiptWorkIds.length ? "receipt" : "evidence" };
  }

  private project(predicate: ProgramPredicate, resources: ProgramResources, additional: string[] = []) {
    const state = Object.fromEntries([...new Set([...predicate.reads, ...additional])].map(key => {
      const value = resources[key];
      if (!value || !Number.isSafeInteger(value.version) || value.version < 0) throw new Error(`missing versioned predicate input ${key}`);
      assertJsonValue(value.value, `resource ${key}`);
      return [key, structuredClone(value)];
    }));
    const dependencies = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value.version]));
    const inputHash = contentHash({ programHash: this.program.hash, predicate, parameters: this.parameters, state });
    return { state, dependencies, inputHash };
  }

  private predicateWork(predicateId: string, reason: ProgramPredicateWork["reason"], subjectId: string, resources: ProgramResources): ProgramPredicateWork | null {
    const predicate = this.predicates.get(predicateId)!;
    const projected = this.project(predicate, resources, reason === "goal" ? [`goal:${subjectId}`] : []);
    const checkKey = `${reason}:${subjectId}`;
    if (this.checked.get(checkKey) === projected.inputHash) return null;
    if (reason === "flow" && this.seenFlow.get(`${this.find(subjectId).nodeId}:${projected.inputHash}`) === this.progress) return null;
    let mechanicalVerdict: Verdict | null = null;
    if (predicate.test.kind === "mechanical") {
      try {
        const left = evaluateExpression(predicate.test.left, this.parameters, projected.state);
        const right = evaluateExpression(predicate.test.right, this.parameters, projected.state);
        if (predicate.test.operator === "eq") mechanicalVerdict = contentHash(left) === contentHash(right) ? "yes" : "no";
        else if (predicate.test.operator === "ne") mechanicalVerdict = contentHash(left) !== contentHash(right) ? "yes" : "no";
        else if (typeof left === "number" && typeof right === "number") {
          const yes = predicate.test.operator === "lt" ? left < right : predicate.test.operator === "lte" ? left <= right
            : predicate.test.operator === "gt" ? left > right : left >= right;
          mechanicalVerdict = yes ? "yes" : "no";
        } else mechanicalVerdict = "unknown";
      } catch { mechanicalVerdict = "unknown"; }
    }
    // A generated arithmetic condition cannot itself prove an authored long-term goal.
    if (reason === "goal" && mechanicalVerdict === "yes") mechanicalVerdict = null;
    return { kind: "predicate", predicateId, reason, subjectId, ...projected, mechanicalVerdict,
      id: contentHash({ instanceId: this.instanceId, definitionHash: this.program.hash, reason, subjectId, inputHash: projected.inputHash }) };
  }

  work(resources: ProgramResources, atSeconds: number): ProgramWork[] {
    this.checkTime(atSeconds);
    if (this.paused || this.expansion) return [];
    if (!this.started) {
      const start = this.predicateWork(this.program.definition.startPredicateId, "start", "start", resources);
      return start ? [start] : [];
    }
    const work: ProgramWork[] = [];
    for (const predicateId of this.program.definition.interrupts) {
      const ticket = this.predicateWork(predicateId, "interrupt", predicateId, resources); if (ticket) work.push(ticket);
    }
    for (const milestone of this.program.definition.milestones) if (!this.milestoneEvidence.has(milestone.id)) {
      const ticket = this.predicateWork(milestone.predicateId, "milestone", milestone.id, resources); if (ticket) work.push(ticket);
    }
    for (const goal of this.program.definition.goals) if (!this.goalEvidence.has(goal.goalId)) {
      const ticket = this.predicateWork(goal.predicateId, "goal", goal.goalId, resources); if (ticket) work.push(ticket);
    }
    for (const leaf of this.leaves()) {
      const node = this.nodes.get(leaf.nodeId)!;
      if (leaf.issued) continue;
      if (node.kind === "attempt") {
        const inputHash = this.attemptInput(resources);
        if (leaf.lastInputHash === inputHash) continue;
        const render = (text: string) => text.replace(/\{([a-zA-Z0-9_.:-]+)\}/gu, (_, name: string) => String(this.parameters[name]));
        work.push({ kind: node.speech.kind === "create" && leaf.utterance === null ? "utterance" : "attempt", id: this.workId(leaf), nodeId: node.id,
          inputHash, intent: render(node.intent), targetIds: node.entityTargetParameters.map(name => String(this.parameters[name])),
          utterance: leaf.utterance ?? (node.speech.kind === "authored" ? render(node.speech.text) : null) });
      } else if (node.kind === "branch" || node.kind === "repeat" || node.kind === "wait") {
        if (node.kind === "wait" && node.deadlineSeconds !== null && atSeconds >= leaf.atSeconds! + node.deadlineSeconds) {
          work.push({ kind: "deadline", id: this.workId(leaf), nodeId: node.id, inputHash: contentHash({ deadline: leaf.atSeconds! + node.deadlineSeconds }),
            intent: "", targetIds: [], utterance: null });
        } else {
          const ticket = this.predicateWork(node.predicateId, "flow", this.workId(leaf), resources); if (ticket) work.push(ticket);
        }
      }
    }
    return work;
  }

  /** A batched verdict must still match this owner's current actual dependency values and versions. */
  resolve(work: ProgramPredicateWork, resources: ProgramResources, verdict: Verdict, evidenceHash: string, atSeconds: number) {
    const current = this.work(resources, atSeconds).find(item => item.id === work.id);
    if (!current || contentHash(current) !== contentHash(work)) throw new Error("stale or foreign program predicate ticket");
    if (work.mechanicalVerdict !== null && work.mechanicalVerdict !== verdict) throw new Error("model cannot override a mechanical condition");
    this.apply({ kind: "predicate", ticket: work.id, predicateId: work.predicateId, reason: work.reason, subjectId: work.subjectId,
      inputHash: work.inputHash, verdict, evidenceHash, atSeconds });
  }

  issue(work: ProgramAttemptWork, resources: ProgramResources, atSeconds: number): string {
    const current = this.work(resources, atSeconds).find(item => item.id === work.id);
    if (work.kind !== "attempt" || !current || contentHash(current) !== contentHash(work)) throw new Error("attempt is stale or needs creation before dispatch");
    const requestHash = contentHash({ instanceId: this.instanceId, definitionHash: this.program.hash, work });
    this.apply({ kind: "issue", workId: work.id, requestHash, atSeconds });
    return requestHash;
  }

  supplyUtterance(work: ProgramAttemptWork, text: string, resources: ProgramResources, atSeconds: number) {
    const current = this.work(resources, atSeconds).find(item => item.id === work.id);
    if (work.kind !== "utterance" || !current || contentHash(current) !== contentHash(work)) throw new Error("stale utterance creation ticket");
    this.apply({ kind: "utterance", workId: work.id, text, atSeconds });
  }

  settle(receiptId: string, receipts: ReadonlyMap<string, ProgramReceipt>, resources: ProgramResources) {
    const receipt = receipts.get(receiptId); if (!receipt) throw new Error("missing canonical program receipt");
    this.apply({ kind: "settle", receipt, waitInputHash: this.attemptInput(resources) });
  }

  expire(work: ProgramAttemptWork, atSeconds: number) {
    if (work.kind !== "deadline") throw new Error("only wait deadlines may expire");
    this.apply({ kind: "deadline", workId: work.id, atSeconds });
  }
  interrupt(reason: string, atSeconds: number) { this.apply({ kind: "interrupt", reason, atSeconds }); }
  resume(atSeconds: number) { this.apply({ kind: "resume", atSeconds }); }

  private attemptInput(resources: ProgramResources): string {
    return contentHash(this.program.definition.reads.map(key => {
      if (!resources[key]) throw new Error(`missing attempt dependency ${key}`);
      return [key, resources[key]];
    }));
  }
  private checkTime(atSeconds: number) { ordinal.parse(atSeconds); if (atSeconds < this.now) throw new Error("program time moved backwards"); }
  private activate(nodeId: string): Leaf { return { kind: "leaf", nodeId, activation: this.activation++, atSeconds: null, issued: null, lastInputHash: null, utterance: null }; }
  private workId(leaf: Leaf) { return contentHash({ instance: this.instanceId, definition: this.program.hash, node: leaf.nodeId, activation: leaf.activation }); }
  private leaves(term = this.root): Leaf[] {
    if (term.kind === "leaf") return [term];
    if (term.kind === "done") return [];
    if (term.kind === "branch" || term.kind === "repeat-body") return this.leaves(term.child);
    if (term.kind === "parallel") return term.children.flatMap(child => this.leaves(child));
    const next = term.children.find(child => child.kind !== "done"); return next ? this.leaves(next) : [];
  }
  private find(workId: string) { const leaf = this.leaves().find(leaf => this.workId(leaf) === workId); if (!leaf) throw new Error("work is outside the program frontier"); return leaf; }
  private replace(leaf: Leaf, replacement: Residual, term = this.root): Residual {
    if (leaf === term) return replacement;
    if (term.kind === "branch" || term.kind === "repeat-body") return { ...term, child: this.replace(leaf, replacement, term.child) };
    if (term.kind === "sequence" || term.kind === "parallel") return { ...term, children: term.children.map(child => this.replace(leaf, replacement, child)) };
    return term;
  }
  private normalize(term: Residual): Residual {
    if (term.kind === "leaf") {
      const node = this.nodes.get(term.nodeId)!;
      if (node.kind === "finish") return { kind: "done", nodeId: node.id };
      if (node.kind !== "sequence" && node.kind !== "parallel") { term.atSeconds ??= this.now; return term; }
      return this.normalize({ kind: node.kind, nodeId: node.id, children: node.children.map(id => this.activate(id)) });
    }
    if (term.kind === "done") return term;
    if (term.kind === "branch" || term.kind === "repeat-body") {
      term.child = this.normalize(term.child);
      return term.child.kind === "done" ? term.kind === "branch" ? { kind: "done", nodeId: term.nodeId } : this.activate(term.nodeId) : term;
    }
    for (let index = 0; index < term.children.length; index++) {
      term.children[index] = this.normalize(term.children[index]!);
      if (term.kind === "sequence" && term.children[index]!.kind !== "done") break;
    }
    return term.children.every(child => child.kind === "done") ? { kind: "done", nodeId: term.nodeId } : term;
  }

  private apply(input: JournalEvent) {
    const previousTime = this.now;
    try { this.applyChecked(input); }
    catch (error) { this.now = previousTime; throw error; }
  }

  private applyChecked(input: JournalEvent) {
    const event = eventSchema.parse(input), time = event.kind === "settle" ? event.receipt.atSeconds : event.atSeconds;
    this.checkTime(time); this.now = time;
    if (event.kind === "interrupt") this.paused = true;
    else if (event.kind === "resume") { if (!this.paused) throw new Error("program is not interrupted"); this.paused = false; }
    else if (event.kind === "settle") {
      if (this.settledReceipts.has(event.receipt.id)) throw new Error("program receipt already settled");
      const receipt = event.receipt, leaf = this.find(receipt.workId), node = this.nodes.get(leaf.nodeId)!;
      if (receipt.instanceId !== this.instanceId || leaf.issued !== receipt.requestHash || node.kind !== "attempt") throw new Error("receipt does not settle the issued attempt");
      this.settledReceipts.add(receipt.id);
      if (receipt.madeProgress) this.progress++;
      if (receipt.status === "succeeded") this.root = this.replace(leaf, { kind: "done", nodeId: leaf.nodeId });
      else {
        const route = receipt.status === "partial" ? node.onPartial : node.onFailure;
        if (route === "expand") this.expansion = `${receipt.status}:${node.id}`;
        else { leaf.issued = null; leaf.activation = this.activation++; leaf.lastInputHash = event.waitInputHash; leaf.utterance = null; }
      }
    } else {
      if (this.paused || this.expansion) throw new Error("program is not dispatchable");
      if (event.kind === "predicate") {
        const predicate = this.predicates.get(event.predicateId); if (!predicate) throw new Error("unknown predicate journal entry");
        if (event.ticket !== contentHash({ instanceId: this.instanceId, definitionHash: this.program.hash,
          reason: event.reason, subjectId: event.subjectId, inputHash: event.inputHash })) throw new Error("predicate ticket hash mismatch");
        if (event.reason === "goal" && !this.program.definition.goals.some(goal => goal.goalId === event.subjectId && goal.predicateId === event.predicateId)) throw new Error("goal predicate is not declared");
        if (event.reason === "milestone" && !this.program.definition.milestones.some(milestone => milestone.id === event.subjectId && milestone.predicateId === event.predicateId)) throw new Error("milestone predicate is not declared");
        if (event.reason === "interrupt" && (event.subjectId !== event.predicateId || !this.program.definition.interrupts.includes(event.predicateId))) throw new Error("interrupt predicate is not declared");
        if (event.reason === "start" && (event.subjectId !== "start" || this.started || event.predicateId !== this.program.definition.startPredicateId)) throw new Error("invalid start predicate");
        const checkKey = `${event.reason}:${event.subjectId}`;
        if (this.checked.get(checkKey) === event.inputHash) throw new Error("duplicate unchanged predicate");
        this.checked.set(checkKey, event.inputHash);
        if (event.reason === "start") {
          if (event.verdict === "yes") this.started = true;
          else if (event.verdict === "no" || predicate.unknown === "expand") this.expansion = `inapplicable:${predicate.id}`;
        }
        else if (event.reason === "interrupt") { if (event.verdict === "yes") this.paused = true; }
        else if (event.reason === "milestone") { if (event.verdict === "yes") this.milestoneEvidence.set(event.subjectId, event.evidenceHash); }
        else if (event.reason === "goal") { if (event.verdict === "yes") this.goalEvidence.set(event.subjectId, event.evidenceHash); }
        else {
          const leaf = this.find(event.subjectId), node = this.nodes.get(leaf.nodeId)!;
          if (!(node.kind === "branch" || node.kind === "repeat" || node.kind === "wait") || node.predicateId !== event.predicateId) throw new Error("predicate does not belong to this control node");
          this.seenFlow.set(`${node.id}:${event.inputHash}`, this.progress);
          if (event.verdict === "unknown") { if (predicate.unknown === "expand") this.expansion = `unknown:${predicate.id}`; }
          else if (node.kind === "branch") this.root = this.replace(leaf, { kind: "branch", nodeId: node.id, child: this.activate(event.verdict === "yes" ? node.yes : node.no) });
          else if (node.kind === "repeat") this.root = this.replace(leaf, event.verdict === "yes"
            ? { kind: "repeat-body", nodeId: node.id, child: this.activate(node.body) } : { kind: "done", nodeId: node.id });
          else if (event.verdict === "yes") this.root = this.replace(leaf, { kind: "done", nodeId: node.id });
        }
      } else {
        const leaf = this.find(event.workId), node = this.nodes.get(leaf.nodeId)!;
        if (event.kind === "deadline") {
          if (node.kind !== "wait" || node.deadlineSeconds === null || time < leaf.atSeconds! + node.deadlineSeconds) throw new Error("wait deadline has not arrived");
          this.expansion = `deadline:${node.id}`;
        } else {
          if (node.kind !== "attempt" || leaf.issued) throw new Error("attempt is not ready");
          if (event.kind === "issue") { if (node.speech.kind === "create" && leaf.utterance === null) throw new Error("utterance must exist before issue"); leaf.issued = event.requestHash; }
          else { if (node.speech.kind !== "create" || leaf.utterance !== null) throw new Error("unexpected utterance"); leaf.utterance = event.text; }
        }
      }
    }
    this.root = this.normalize(this.root);
    this.events.push(structuredClone(event));
  }
}
