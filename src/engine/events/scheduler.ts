import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { programHash, type ProgramResources } from "../programs/definition";
import type { JsonValue } from "../runtime/json";

const second = z.number().int().nonnegative().safe();
const scheduledSchema = z.object({ id: programHash, ordinal: second, atSeconds: second, subjectId: z.string().min(1).nullable(),
  kind: z.enum(["world", "observation", "dependency", "deadline", "timer", "receipt", "control"]),
  inputHash: programHash, payload: z.json() }).strict();
export type ScheduledEvent = z.infer<typeof scheduledSchema>;
const subscriptionSchema = z.object({ subjectId: z.string().min(1), versions: z.record(z.string(), second),
  receiptWorkIds: z.array(programHash), deadline: second.nullable() }).strict();
const snapshotSchema = z.object({ version: z.literal(1), clock: second, nextOrdinal: second,
  pending: z.array(scheduledSchema), completed: z.array(programHash), subscriptions: z.array(subscriptionSchema),
  evaluations: z.record(z.string(), programHash), hash: programHash }).strict();

/** One canonical event order; private wake subscriptions contain versions, never another subject's cognition. */
export class EventScheduler {
  private clock: number;
  private nextOrdinal = 0;
  private readonly pending = new Map<string, ScheduledEvent>();
  private readonly completed = new Set<string>();
  private readonly subscriptions = new Map<string, z.infer<typeof subscriptionSchema>>();
  private readonly evaluations = new Map<string, string>();
  constructor(clock = 0, snapshot?: unknown) {
    this.clock = second.parse(clock);
    if (snapshot !== undefined) {
      const { hash, ...value } = snapshotSchema.parse(snapshot);
      if (hash !== contentHash(value) || value.clock !== clock) throw new Error("event scheduler clock or checksum mismatch");
      this.nextOrdinal = value.nextOrdinal;
      for (const id of value.completed) { if (this.completed.has(id)) throw new Error("duplicate completed event"); this.completed.add(id); }
      const ordinals = new Set<number>();
      for (const event of value.pending) {
        if (this.pending.has(event.id) || this.completed.has(event.id) || event.atSeconds < clock || event.ordinal >= value.nextOrdinal || ordinals.has(event.ordinal)) throw new Error("invalid pending event");
        const { id, atSeconds, subjectId, kind, inputHash, payload } = event;
        const body = { atSeconds, subjectId, kind, inputHash, payload };
        if (id !== contentHash(body)) throw new Error("pending event identity mismatch");
        this.pending.set(id, event); ordinals.add(event.ordinal);
      }
      for (const subscription of value.subscriptions) {
        if (this.subscriptions.has(subscription.subjectId)) throw new Error("duplicate wake subscription");
        this.subscriptions.set(subscription.subjectId, subscription);
      }
      for (const [owner, signature] of Object.entries(value.evaluations)) this.evaluations.set(owner, signature);
    }
  }
  schedule(input: { atSeconds: number; subjectId: string | null; kind: ScheduledEvent["kind"]; inputHash: string; payload: JsonValue }): string {
    if (input.atSeconds < this.clock || input.kind === "world" && input.atSeconds <= this.clock) throw new Error("event is before its valid time boundary");
    const id = contentHash(input);
    if (!this.pending.has(id) && !this.completed.has(id)) {
      const event = scheduledSchema.parse({ ...input, id, ordinal: this.nextOrdinal });
      this.pending.set(id, event); this.nextOrdinal += 1;
    }
    return id;
  }
  get nextTime(): number | null { return this.pending.size ? Math.min(...[...this.pending.values()].map(event => event.atSeconds)) : null; }
  frontier(): ScheduledEvent[] {
    return structuredClone([...this.pending.values()].filter(event => event.atSeconds === this.nextTime).sort((a, b) => a.ordinal - b.ordinal));
  }
  /** A caller must durably commit this boundary before acknowledging it. Partial ACKs retain the barrier. */
  acknowledge(ids: string[], atSeconds: number): void {
    if (!ids.length || new Set(ids).size !== ids.length || atSeconds !== this.nextTime || atSeconds < this.clock) throw new Error("event acknowledgement skips the canonical frontier");
    for (const id of ids) if (this.pending.get(id)?.atSeconds !== atSeconds) throw new Error("event acknowledgement is not in this frontier");
    for (const id of ids) { this.pending.delete(id); this.completed.add(id); }
    this.clock = atSeconds;
  }
  cancel(id: string): void {
    if (!this.pending.has(id)) throw new Error("cannot cancel an unknown pending event");
    this.pending.delete(id); this.completed.add(id);
  }
  /** Advance over a canonical timer/expiry boundary that has no separate private queue item. */
  advanceBoundary(atSeconds: number): void {
    second.parse(atSeconds);
    if (atSeconds < this.clock || this.nextTime !== null && this.nextTime < atSeconds) throw new Error("clock advance skips a pending event");
    this.clock = atSeconds;
  }
  unsubscribe(subjectId: string): void {
    this.subscriptions.delete(subjectId);
    for (const event of [...this.pending.values()]) if (event.subjectId === subjectId) this.cancel(event.id);
  }
  subscribe(subjectId: string, resources: ProgramResources, keys: string[], receiptWorkIds: string[], deadline: number | null) {
    const subscription = subscriptionSchema.parse({ subjectId, versions: Object.fromEntries([...new Set(keys)].sort().map(key => {
      if (!resources[key]) throw new Error(`missing private subscription resource ${key}`); return [key, resources[key]!.version];
    })), receiptWorkIds: [...new Set(receiptWorkIds)], deadline });
    if (deadline !== null && deadline < this.clock) throw new Error("subscription deadline has already passed");
    const prior = this.subscriptions.get(subjectId);
    if (prior && contentHash(prior) !== contentHash(subscription)) for (const event of this.pending.values()) {
      if (event.subjectId === subjectId && event.kind === "deadline") this.cancel(event.id);
    }
    this.subscriptions.set(subjectId, subscription);
    if (deadline !== null) this.schedule({ atSeconds: deadline, subjectId, kind: "deadline", inputHash: contentHash(subscription), payload: { deadline } });
  }
  notify(subjectId: string, resources: ProgramResources): string | null {
    const subscription = this.subscriptions.get(subjectId); if (!subscription) return null;
    const changed = Object.entries(subscription.versions).filter(([key, version]) => resources[key]?.version !== version).map(([key]) => key).sort();
    if (!changed.length) return null;
    const versions = Object.fromEntries(Object.keys(subscription.versions).map(key => [key, resources[key]?.version ?? null]));
    return this.schedule({ atSeconds: this.clock, subjectId, kind: "dependency", inputHash: contentHash({ versions, changed }), payload: { resources: changed } });
  }
  receipt(subjectId: string, workId: string, receiptId: string): string | null {
    if (!this.subscriptions.get(subjectId)?.receiptWorkIds.includes(workId)) return null;
    return this.schedule({ atSeconds: this.clock, subjectId, kind: "receipt", inputHash: contentHash({ workId, receiptId }), payload: { workId, receiptId } });
  }
  /** False means the exact same authorized input/frontier was already evaluated without committed progress. */
  beginEvaluation(subjectId: string, inputHash: string, frontierHash: string, progressHash: string): boolean {
    const signature = contentHash({ subjectId, inputHash, frontierHash });
    if (this.evaluations.get(signature) === progressHash) return false;
    this.evaluations.set(signature, progressHash); return true;
  }
  snapshot() {
    const value = { version: 1 as const, clock: this.clock, nextOrdinal: this.nextOrdinal, pending: [...this.pending.values()], completed: [...this.completed],
      subscriptions: [...this.subscriptions.values()], evaluations: Object.fromEntries(this.evaluations) };
    return structuredClone({ ...value, hash: contentHash(value) });
  }
}

export interface ActionDependencies { id: string; actorEntityId: string; targetEntityIds: string[]; reads: string[]; writes: string[] }
const collections: Record<string, string> = { entity: "entities", placement: "placements", fact: "facts", meter: "meters", quantity: "quantities", rating: "ratings",
  condition: "conditions", pool: "pools", activity: "activities", timer: "timers", law: "laws" };
const overlaps = (left: string, right: string) => left === right || collections[left.slice(0, left.indexOf(":"))] === right || collections[right.slice(0, right.indexOf(":"))] === left;

/** Connected effects and interaction partners stay together; only disjoint components may prepare concurrently. */
export function jointActionComponents(actions: ActionDependencies[]): ActionDependencies[][] {
  if (new Set(actions.map(action => action.id)).size !== actions.length) throw new Error("duplicate scheduled action");
  const remaining = new Map(actions.map(action => [action.id, action])), components: ActionDependencies[][] = [];
  const related = (a: ActionDependencies, b: ActionDependencies) => a.actorEntityId === b.actorEntityId || a.targetEntityIds.includes(b.actorEntityId) || b.targetEntityIds.includes(a.actorEntityId) ||
    a.writes.some(key => [...b.reads, ...b.writes].some(other => overlaps(key, other))) || b.writes.some(key => a.reads.some(other => overlaps(key, other)));
  while (remaining.size) {
    const group = [remaining.values().next().value!]; remaining.delete(group[0]!.id);
    for (let cursor = 0; cursor < group.length; cursor++) for (const candidate of remaining.values()) if (related(group[cursor]!, candidate)) {
      group.push(candidate); remaining.delete(candidate.id);
    }
    components.push(group.sort((a, b) => a.id.localeCompare(b.id)));
  }
  return components.sort((a, b) => a[0]!.id.localeCompare(b[0]!.id));
}
