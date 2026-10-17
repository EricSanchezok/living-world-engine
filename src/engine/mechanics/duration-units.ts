import { semanticIdSchema } from "../contracts/state-schemas";
import { assertExactKeys } from "../runtime/json";

export const standardDurationUnits: Readonly<Record<string, number>> = { second: 1, seconds: 1, 秒: 1, 秒钟: 1, minute: 60, minutes: 60, 分: 60, 分钟: 60, hour: 3600, hours: 3600, 小时: 3600 };

/** An authored elapsed unit; calendar dates and clock phases are separate. */
export interface DurationUnitDefinition {
  id: string;
  terms: string[];
  seconds: number;
  locationIds: string[];
}

export function validateDurationUnits(units: Record<string, DurationUnitDefinition>, entityIds?: ReadonlySet<string>): void {
  const scopes = new Set<string>();
  for (const [id, unit] of Object.entries(units)) {
    assertExactKeys(unit, ["id", "terms", "seconds", "locationIds"], [], "duration unit");
    semanticIdSchema.parse(id);
    if (id !== unit.id || !unit.terms.length || !Number.isSafeInteger(unit.seconds) || unit.seconds <= 0) throw new Error(`invalid duration unit ${id}`);
    if (new Set(unit.locationIds).size !== unit.locationIds.length) throw new Error(`duplicate duration unit location ${id}`);
    for (const location of unit.locationIds) {
      semanticIdSchema.parse(location);
      if (entityIds && !entityIds.has(location)) throw new Error(`duration unit ${id} has unknown location ${location}`);
    }
    for (const term of unit.terms) {
      if (!term.trim() || term !== term.trim() || /[\d\p{Cc}]/u.test(term)) throw new Error(`invalid duration unit term ${id}`);
      for (const scope of unit.locationIds.length ? unit.locationIds : [""]) {
        const key = JSON.stringify([scope, term.toLocaleLowerCase("en-US")]);
        if (scopes.has(key)) throw new Error(`conflicting duration unit term ${term} at ${scope || "global"}`);
        scopes.add(key);
      }
    }
  }
}

/** The closest containing place overrides a global term, without revealing its identity. */
export function resolveDurationUnits(units: Record<string, DurationUnitDefinition>, placements: Readonly<Record<string, string | null>>, actorEntityId: string): Record<string, number> {
  const ancestry: string[] = [];
  for (let place = placements[actorEntityId]; place && !ancestry.includes(place); place = placements[place]) ancestry.push(place);
  const result: Record<string, number> = {}, ranks = new Map<string, number>();
  for (const unit of Object.values(units)) {
    const rank = unit.locationIds.length ? Math.min(...unit.locationIds.map(id => ancestry.indexOf(id)).filter(index => index >= 0)) : ancestry.length;
    if (!Number.isFinite(rank)) continue;
    for (const name of unit.terms) {
      const term = name.toLocaleLowerCase("en-US"), prior = ranks.get(term);
      if (prior === undefined || rank < prior) { result[term] = unit.seconds; ranks.set(term, rank); }
      else if (rank === prior) throw new Error(`ambiguous duration unit ${term}`);
    }
  }
  return result;
}
