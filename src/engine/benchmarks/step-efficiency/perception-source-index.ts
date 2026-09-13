import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";

type Value = Record<string, unknown>;
const fail = (message: string): never => { throw new ModelConfigurationError(`perception source index: ${message}`); };
const record = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : fail("missing record");
const rows = (value: unknown): Value[] => Array.isArray(value) ? value.map(record) : fail("missing rows");
const unique = (values: Value[], field: string) => {
  const map = new Map<string, Value>();
  for (const value of values) {
    if (typeof value[field] !== "string" || map.has(value[field])) return fail(`duplicate or missing ${field}`);
    map.set(value[field], value);
  }
  return map;
};
const instruction = "\n\nAssigned observer/source index (exact source data, not visibility findings). Each row joins its original targetIndex and observerRef to that observer's record, the source action's actual actor and complete attempted action, both current placement chains, and all existing observer-owned Ratings. Catalog statePath identities establish the Entity/Placement joins; names do not. Read this index together with all original evidence and laws. The observer is doing the noticing; sourceActor is attempting sourceAction. A placement chain is evidence to interpret, not a verdict or an automatic sensory route. The index selects no aptitude, check, outcome or stimulus. Current source actions remain attempts, not already completed events. Use original handles and the unchanged canonical output schema.\n";
export const PERCEPTION_SOURCE_INDEX = `perception-source-index-v1@${contentHash(instruction).slice(0, 16)}`;

/** Exact relational joins over the complete model-visible source; no semantic filtering. */
export function buildPerceptionSourceIndex(context: unknown) {
  const source = record(context), state = record(source.state), truth = record(state.canonicalTruth);
  const catalog = rows(record(source.referenceCatalog).candidates), catalogByHandle = unique(catalog, "handle");
  const actors = rows(state.actors), byAgent = unique(actors, "agentRef"), byEntity = unique(actors, "entityRef");
  const actions = unique(rows(record(state.actionSet).available), "actionRef");
  const entities = record(truth.entities), placements = record(truth.placements), ratings = record(truth.ratings);
  const entityByKey = new Map<string, string>(), entityKeyByHandle = new Map<string, string>();
  const placementByKey = new Map<string, string>(), placementKeyByHandle = new Map<string, string>();
  for (const row of catalog) {
    const prefix = row.kind === "entity" ? "state.truth.entities." : row.kind === "placement" ? "state.truth.placements." : null;
    if (!prefix) continue;
    if (typeof row.statePath !== "string" || !row.statePath.startsWith(prefix)) return fail("missing canonical statePath binding");
    const key = row.statePath.slice(prefix.length), handle = String(row.handle);
    const byKey = row.kind === "entity" ? entityByKey : placementByKey;
    const byHandle = row.kind === "entity" ? entityKeyByHandle : placementKeyByHandle;
    if (!key || byKey.has(key)) return fail("duplicate canonical identity");
    byKey.set(key, handle); byHandle.set(handle, key);
  }
  const chain = (entityRef: string) => {
    const result: Value[] = [], seen = new Set<string>();
    let current: string | null = entityRef;
    while (current !== null) {
      if (seen.has(current)) return fail("cyclic placement chain");
      seen.add(current);
      const entity = record(entities[current]), key = entityKeyByHandle.get(current);
      const placementRef = key === undefined ? undefined : placementByKey.get(key);
      if (!placementRef || !Object.hasOwn(placements, placementRef)) return fail("missing placement edge");
      const parent = placements[placementRef];
      if (parent !== null && typeof parent !== "string") return fail("invalid placement parent");
      if (entity.placementRef !== parent) return fail("entity and placement evidence disagree");
      const parentKey = parent === null ? null : placementKeyByHandle.get(parent);
      const containerEntityRef = parentKey === null ? null : parentKey === undefined ? undefined : entityByKey.get(parentKey);
      if (containerEntityRef === undefined) return fail("missing container identity");
      result.push({ entityRef: current, entity, placementRef, containerEntityRef });
      current = containerEntityRef;
    }
    return result;
  };
  const targets = rows(record(record(source.task).assignment).perceptionTargets), seen = new Set<number>();
  const workItems = targets.map(pair => {
    if (!Number.isSafeInteger(pair.targetIndex) || seen.has(pair.targetIndex as number)) return fail("duplicate target index");
    seen.add(pair.targetIndex as number);
    const observer = byEntity.get(String(pair.observerRef)), action = actions.get(String(pair.sourceActionRef));
    if (!observer || !action) return fail("unbound observer or action");
    const sourceActor = byAgent.get(String(action.actorRef));
    if (!sourceActor) return fail("unbound source actor");
    const observerRatings = Object.entries(ratings).filter(([, value]) => record(value).entityRef === pair.observerRef).map(([ratingRef, value]) => {
      if (catalogByHandle.get(ratingRef)?.kind !== "rating") return fail("uncatalogued observer Rating");
      return { ratingRef, rating: value };
    });
    return { ...pair, observer, sourceActor, sourceAction: action,
      observerPlacementChain: chain(String(observer.entityRef)), sourceActorPlacementChain: chain(String(sourceActor.entityRef)), observerRatings };
  });
  return structuredClone({ sourceContextHash: contentHash(source), elapsedSeconds: truth.elapsedSeconds, workItems });
}

export function perceptionSourceIndexRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  if (request.promptVersion.includes(PERCEPTION_SOURCE_INDEX) || request.jsonObjectPostlude?.includes(instruction)) return fail("already indexed");
  const sourceHash = contentHash(request.context), index = buildPerceptionSourceIndex(request.context);
  return { ...request, promptVersion: `${request.promptVersion}/${PERCEPTION_SOURCE_INDEX}`,
    jsonObjectPostlude: `${request.jsonObjectPostlude ?? ""}${instruction}${JSON.stringify(index)}`,
    preprocessOutput: value => {
      if (contentHash(request.context) !== sourceHash) return fail("source changed before output validation");
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
