import { z } from "zod";
import type { AgentActionProposal, AgentPerspectiveView, SimulationState } from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import { agentIntentProgramSchema, inspectAgentIntentProgram, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";

const ordinal = z.number().int().nonnegative(), text = z.string().min(1);
const actionSchema = z.strictObject({ id: text, actorId: text, baseRevision: ordinal,
  rawText: text, goal: text, means: z.null(), targetIds: z.array(text) });
const sourceSchema = z.strictObject({ worldHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  action: actionSchema, program: agentIntentProgramSchema });
const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("issue"), workId: text, revision: ordinal, action: actionSchema }),
  z.strictObject({ kind: z.literal("guard"), workId: text, perspectiveHash: text, revision: ordinal,
    verdict: z.enum(["true", "false", "unknown"]) }),
  z.strictObject({ kind: z.literal("settle"), workId: text, revision: ordinal, activityId: text, commitHash: text,
    status: z.enum(["completed", "partial", "failed", "blocked", "cancelled"]) }),
  z.strictObject({ kind: z.literal("suspend"), reason: text }),
  z.strictObject({ kind: z.literal("resume") }),
]);
const snapshotSchema = z.strictObject({ version: z.literal(1), source: sourceSchema,
  events: z.array(eventSchema), hash: text });
type Source = z.infer<typeof sourceSchema>;
type Node = Source["program"]["nodes"][number];
type Event = z.infer<typeof eventSchema>;
type Leaf = { kind: "leaf"; nodeId: number; activation: number; issued: AgentActionProposal | null;
  lastPerspectiveHash: string | null; settledFailure: boolean };
type Residual = Leaf | { kind: "done"; nodeId: number }
  | { kind: "sequence"; nodeId: number; children: Residual[] }
  | { kind: "parallel"; nodeId: number; children: Residual[] }
  | { kind: "branch"; nodeId: number; child: Residual }
  | { kind: "while-body"; nodeId: number; child: Residual };

export interface IntentWork {
  workId: string;
  nodeId: number;
  kind: "attempt" | "await" | "if" | "while";
  text: string;
  targetIds: string[];
  issuedAction: AgentActionProposal | null;
  lastPerspectiveHash: string | null;
}
export interface IntentGuardTicket {
  sourceHash: string;
  work: IntentWork;
  perspective: AgentPerspectiveView;
  perspectiveHash: string;
}

/** Residual execution inspired by IndiGolog's Trans/Final distinction; see
 * docs/decisions/0222-execute-residual-intention-programs.md. This experimental
 * kernel consumes trusted commit evidence; it never commits world effects. */
export class IntentExecutionCursor {
  private readonly source: Source;
  private readonly nodes: Map<number, Node>;
  private readonly sourceHash: string;
  private root: Residual;
  private nextActivation = 0;
  private events: Event[] = [];
  private paused = false;
  private halted = false;
  private lastRevision: number;

  constructor(source: Source) {
    this.source = sourceSchema.parse(source);
    const { action, program } = this.source;
    if (new Set(action.targetIds).size !== action.targetIds.length ||
      action.rawText !== INTENT_PROGRAM_PREFIX + JSON.stringify(program) || action.goal !== action.rawText) {
      throw new Error("intent cursor requires the exact complete producer embedding");
    }
    inspectAgentIntentProgram(program, action.targetIds.length);
    this.sourceHash = contentHash(this.source);
    this.nodes = new Map(program.nodes.map(node => [node.nodeId, node]));
    this.lastRevision = action.baseRevision;
    this.root = this.normalize(this.activate(program.root));
  }

  /** Restore only an engine-owned journal from trusted storage. Its digest
   * detects corruption, not a malicious writer who can replace the digest. */
  static restore(value: unknown): IntentExecutionCursor {
    const snapshot = snapshotSchema.parse(value);
    const { hash, ...payload } = snapshot;
    if (contentHash(payload) !== hash) throw new Error("intent cursor snapshot hash mismatch");
    const cursor = new IntentExecutionCursor(snapshot.source);
    for (const event of snapshot.events) cursor.apply(event);
    return cursor;
  }

  snapshot() {
    const payload = { version: 1 as const, source: this.source, events: this.events };
    return structuredClone({ ...payload, hash: contentHash(payload) });
  }

  get status(): "running" | "suspended" | "completed" | "needs-replan" {
    return this.halted ? "needs-replan" : this.root.kind === "done" ? "completed" : this.paused ? "suspended" : "running";
  }

  frontier(): IntentWork[] {
    return this.leaves().map(leaf => {
      const node = this.nodes.get(leaf.nodeId)!;
      if (node.kind === "sequence" || node.kind === "parallel") throw new Error("unnormalized cursor");
      return { workId: this.workId(leaf), nodeId: node.nodeId, kind: node.kind,
        text: node.kind === "attempt" ? node.text : node.condition,
        targetIds: node.targetIndices.map(index => this.source.action.targetIds[index]!),
        issuedAction: structuredClone(leaf.issued), lastPerspectiveHash: leaf.lastPerspectiveHash };
    });
  }

  /** Bind the exact action allocated by the engine's preparation boundary. */
  issue(workId: string, action: AgentActionProposal): AgentActionProposal {
    const prepared = actionSchema.parse(action);
    this.apply({ kind: "issue", workId, revision: prepared.baseRevision, action: prepared });
    return structuredClone(this.find(workId).issued!);
  }

  guardTicket(workId: string, perspective: AgentPerspectiveView): IntentGuardTicket {
    this.assertDispatchable();
    const work = this.frontier().find(work => work.workId === workId);
    if (!work || work.kind === "attempt") throw new Error("guard is not in the current frontier");
    this.assertPerspective(perspective);
    const perspectiveHash = contentHash(perspective);
    if (work.lastPerspectiveHash === perspectiveHash) throw new Error("guard is waiting for a changed private perspective");
    return structuredClone({ sourceHash: this.sourceHash, work, perspective, perspectiveHash });
  }

  resolveGuard(ticket: IntentGuardTicket, currentPerspective: AgentPerspectiveView, verdict: "true" | "false" | "unknown") {
    this.assertPerspective(currentPerspective);
    const expected = this.guardTicket(ticket.work.workId, currentPerspective);
    if (contentHash(ticket) !== contentHash(expected)) throw new Error("guard ticket source or private perspective changed");
    this.apply({ kind: "guard", workId: ticket.work.workId, perspectiveHash: ticket.perspectiveHash,
      revision: currentPerspective.revision, verdict });
  }

  /** The caller supplies canonical committed state, never a model candidate.
   * Match both the current Activity and its durable transition before advancing. */
  observe(workId: string, state: Readonly<SimulationState>): boolean {
    const leaf = this.find(workId), action = leaf.issued;
    if (!action || leaf.settledFailure) throw new Error("attempt is unissued or already settled");
    if (state.worldHash !== this.source.worldHash || state.revision <= action.baseRevision || state.revision < this.lastRevision) {
      throw new Error("attempt requires a later committed world revision");
    }
    const activities = Object.values(state.truth.activities).filter(activity => activity.sourceActionId === action.id);
    if (activities.length !== 1) throw new Error("issued attempt requires one matching canonical Activity");
    const activity = activities[0]!;
    if (activity.actorId !== action.actorId || contentHash(activity.sourceAction) !== contentHash(action)) {
      throw new Error("committed Activity source differs from the issued attempt");
    }
    if (!["completed", "failed", "blocked", "cancelled"].includes(activity.status)) return false;
    const commit = state.history.find(step => step.revision > action.baseRevision && step.revision <= state.revision &&
      step.activityTransitions.some(transition => transition.activityId === activity.id && transition.kind === activity.status) &&
      contentHash(step.temporalState.activities[activity.id] ?? null) === contentHash(activity));
    if (!commit) throw new Error("terminal Activity has no matching committed transition evidence");
    let status = activity.status as Extract<Event, { kind: "settle" }>["status"];
    if (activity.status === "completed") {
      const outcomes = commit.outcomes.filter(outcome => outcome.proposalId === action.id);
      if (outcomes.length !== 1 || outcomes[0]!.status === "continuing") {
        throw new Error("completed Activity requires one terminal committed action outcome");
      }
      // Scheduled time can finish even when its action was blocked or failed.
      status = outcomes[0]!.status === "succeeded" ? "completed" : outcomes[0]!.status;
    }
    this.apply({ kind: "settle", workId, revision: state.revision, activityId: activity.id, commitHash: commit.contentHash,
      status });
    return true;
  }

  suspend(reason: string) { this.apply({ kind: "suspend", reason }); }
  resume() { this.apply({ kind: "resume" }); }

  private assertPerspective(perspective: AgentPerspectiveView) {
    if (perspective.agentId !== this.source.action.actorId || !Number.isSafeInteger(perspective.revision) ||
      perspective.revision < this.lastRevision) throw new Error("guard requires the owning Agent's current private perspective");
  }

  private assertDispatchable() {
    if (this.status !== "running") throw new Error(`intent cursor cannot dispatch while ${this.status}`);
  }

  private activate(nodeId: number): Leaf {
    return { kind: "leaf", nodeId, activation: this.nextActivation++, issued: null, lastPerspectiveHash: null, settledFailure: false };
  }

  private workId(leaf: Leaf): string { return contentHash({ source: this.sourceHash, node: leaf.nodeId, activation: leaf.activation }); }

  private normalize(term: Residual): Residual {
    if (term.kind === "done") return term;
    if (term.kind === "leaf") {
      const node = this.nodes.get(term.nodeId)!;
      if (node.kind !== "sequence" && node.kind !== "parallel") return term;
      return this.normalize({ kind: node.kind, nodeId: node.nodeId, children: node.children.map(id => this.activate(id)) });
    }
    if (term.kind === "branch" || term.kind === "while-body") {
      term.child = this.normalize(term.child);
      if (term.child.kind !== "done") return term;
      return term.kind === "branch" ? { kind: "done", nodeId: term.nodeId } : this.activate(term.nodeId);
    }
    if (term.kind === "parallel") term.children = term.children.map(child => this.normalize(child));
    else for (let index = 0; index < term.children.length; index++) {
      term.children[index] = this.normalize(term.children[index]!);
      if (term.children[index]!.kind !== "done") break;
    }
    return term.children.every(child => child.kind === "done") ? { kind: "done", nodeId: term.nodeId } : term;
  }

  private leaves(term: Residual = this.root): Leaf[] {
    if (term.kind === "done") return [];
    if (term.kind === "leaf") return [term];
    if (term.kind === "branch" || term.kind === "while-body") return this.leaves(term.child);
    if (term.kind === "parallel") return term.children.flatMap(child => this.leaves(child));
    const next = term.children.find(child => child.kind !== "done");
    return next ? this.leaves(next) : [];
  }

  private find(workId: string): Leaf {
    const leaf = this.leaves().find(leaf => this.workId(leaf) === workId);
    if (!leaf) throw new Error("work is not in the current frontier");
    return leaf;
  }

  private replace(leaf: Leaf, replacement: Residual, term: Residual = this.root): Residual {
    if (term === leaf) return replacement;
    if (term.kind === "branch" || term.kind === "while-body") return { ...term, child: this.replace(leaf, replacement, term.child) };
    if (term.kind === "sequence" || term.kind === "parallel") return { ...term, children: term.children.map(child => this.replace(leaf, replacement, child)) };
    return term;
  }

  private apply(input: Event) {
    const event = eventSchema.parse(input);
    if (event.kind === "suspend") {
      this.assertDispatchable(); this.paused = true;
    } else if (event.kind === "resume") {
      if (this.status !== "suspended") throw new Error("intent cursor is not suspended");
      this.paused = false;
    } else {
      if (event.revision < this.lastRevision) throw new Error("intent evidence revision moved backwards");
      const leaf = this.find(event.workId), node = this.nodes.get(leaf.nodeId)!;
      if (event.kind === "issue") {
        this.assertDispatchable();
        if (node.kind !== "attempt" || leaf.issued) throw new Error("only an unissued attempt can be dispatched");
        const expected = { ...event.action, actorId: this.source.action.actorId, baseRevision: event.revision,
          rawText: node.text, goal: node.text, means: null,
          targetIds: node.targetIndices.map(index => this.source.action.targetIds[index]!) };
        if (contentHash(event.action) !== contentHash(expected)) throw new Error("prepared action differs from the current attempt");
        if (event.action.id === this.source.action.id || this.events.some(previous => previous.kind === "issue" && previous.action.id === event.action.id)) {
          throw new Error("prepared action identity was already used");
        }
        leaf.issued = structuredClone(event.action);
      } else if (event.kind === "settle") {
        if (!leaf.issued || leaf.settledFailure || event.revision <= leaf.issued.baseRevision) throw new Error("invalid attempt settlement");
        if (event.status === "completed") this.root = this.replace(leaf, { kind: "done", nodeId: leaf.nodeId });
        else { leaf.settledFailure = true; this.halted = true; }
      } else {
        this.assertDispatchable();
        if (node.kind === "attempt" || node.kind === "sequence" || node.kind === "parallel" ||
          leaf.lastPerspectiveHash === event.perspectiveHash) throw new Error("invalid or repeated guard decision");
        leaf.lastPerspectiveHash = event.perspectiveHash;
        if (event.verdict !== "unknown") {
          const yes = event.verdict === "true";
          let next: Residual = leaf;
          if (node.kind === "await" && yes) next = { kind: "done", nodeId: node.nodeId };
          if (node.kind === "if") {
            const branch = yes ? node.thenNode : node.elseNode;
            next = branch === null ? { kind: "done", nodeId: node.nodeId }
              : { kind: "branch", nodeId: node.nodeId, child: this.activate(branch) };
          }
          if (node.kind === "while") next = yes
            ? { kind: "while-body", nodeId: node.nodeId, child: this.activate(node.body) }
            : { kind: "done", nodeId: node.nodeId };
          this.root = this.replace(leaf, next);
        }
      }
      this.lastRevision = event.revision;
      this.root = this.normalize(this.root);
    }
    this.events.push(structuredClone(event));
  }
}
