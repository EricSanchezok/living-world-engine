import type { CanonicalWorldState, WorldFact } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { accessSchema, factValueSchema, semanticIdSchema } from "../contracts/state-schemas";
import { assertExactKeys } from "../runtime/json";

export interface PeriodicPropertyDefinition {
  id: string;
  subjectId: string;
  predicate: string;
  access: WorldFact["access"];
  periodSeconds: number;
  initialPhaseSeconds: number;
  phases: Array<{ startsAtSeconds: number; value: WorldFact["value"]; description: string }>;
}

export function validatePeriodicDefinitions(truth: Readonly<CanonicalWorldState>): void {
  const slots = new Set<string>();
  for (const [id, property] of Object.entries(truth.mechanics.periodicProperties)) {
    assertExactKeys(property, ["id", "subjectId", "predicate", "access", "periodSeconds", "initialPhaseSeconds", "phases"], [], "periodic property");
    semanticIdSchema.parse(id); accessSchema.parse(property.access);
    if (id !== property.id || !truth.entities[property.subjectId] || !property.predicate.trim() ||
      !Number.isSafeInteger(property.periodSeconds) || property.periodSeconds <= 0 ||
      !Number.isSafeInteger(property.initialPhaseSeconds) || property.initialPhaseSeconds < 0 || property.initialPhaseSeconds >= property.periodSeconds ||
      property.phases.length < 2 || property.phases[0]!.startsAtSeconds !== 0) throw new Error(`invalid periodic property ${id}`);
    const slot = JSON.stringify([property.subjectId, property.predicate]);
    if (slots.has(slot)) throw new Error(`duplicate periodic property slot ${id}`);
    slots.add(slot);
    let prior = -1;
    for (const phase of property.phases) {
      assertExactKeys(phase, ["startsAtSeconds", "value", "description"], [], "periodic phase");
      factValueSchema.parse(phase.value);
      if (!Number.isSafeInteger(phase.startsAtSeconds) || phase.startsAtSeconds <= prior || phase.startsAtSeconds >= property.periodSeconds ||
        !phase.description.trim() || phase.value.kind === "entity" && !truth.entities[phase.value.entityId]) throw new Error(`invalid periodic phase ${id}`);
      prior = phase.startsAtSeconds;
    }
  }
}

function phaseAt(property: PeriodicPropertyDefinition, elapsedSeconds: number): number {
  if (!Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0) throw new Error("invalid periodic clock");
  return Number((BigInt(elapsedSeconds) + BigInt(property.initialPhaseSeconds)) % BigInt(property.periodSeconds));
}

export function periodicFact(property: PeriodicPropertyDefinition, elapsedSeconds: number): WorldFact {
  const offset = phaseAt(property, elapsedSeconds);
  const phase = property.phases.findLast(item => item.startsAtSeconds <= offset)!;
  return { id: property.id, subjectId: property.subjectId, predicate: property.predicate,
    access: structuredClone(property.access), value: structuredClone(phase.value), description: phase.description,
    provenance: [{ kind: "mechanic", id: `periodic-property:${property.id}` }] };
}

export function nextPeriodicBoundary(property: PeriodicPropertyDefinition, elapsedSeconds: number): number {
  const offset = phaseAt(property, elapsedSeconds);
  const next = property.phases.find(item => item.startsAtSeconds > offset)?.startsAtSeconds ?? property.periodSeconds;
  const boundary = elapsedSeconds + (next - offset);
  if (!Number.isSafeInteger(boundary) || boundary <= elapsedSeconds) throw new Error("periodic clock overflow");
  return boundary;
}

export function assertPeriodicFactWritable(truth: Readonly<CanonicalWorldState>, fact: Pick<WorldFact, "id" | "subjectId" | "predicate">): void {
  if (Object.values(truth.mechanics.periodicProperties).some(property => property.id === fact.id ||
    property.subjectId === fact.subjectId && property.predicate === fact.predicate)) throw new Error(`periodic property is clock-owned: ${fact.id}`);
}

/** The same derivation runs at import, atomic clock advancement and replay. */
export function refreshPeriodicFacts(truth: CanonicalWorldState, elapsedSeconds = truth.elapsedSeconds): void {
  for (const property of Object.values(truth.mechanics.periodicProperties)) truth.facts[property.id] = periodicFact(property, elapsedSeconds);
}

export function initializePeriodicFacts(truth: CanonicalWorldState): void {
  validatePeriodicDefinitions(truth);
  for (const fact of Object.values(truth.facts)) assertPeriodicFactWritable(truth, fact);
  refreshPeriodicFacts(truth);
}

export function validatePeriodicFacts(truth: Readonly<CanonicalWorldState>): void {
  validatePeriodicDefinitions(truth);
  for (const property of Object.values(truth.mechanics.periodicProperties)) {
    if (contentHash(truth.facts[property.id] ?? null) !== contentHash(periodicFact(property, truth.elapsedSeconds)) ||
      truth.factTombstones.includes(property.id)) throw new Error(`periodic property drift ${property.id}`);
  }
  for (const fact of Object.values(truth.facts)) if (!truth.mechanics.periodicProperties[fact.id]) assertPeriodicFactWritable(truth, fact);
}
