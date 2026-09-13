import { z } from "zod";
import { perceptionDirectiveSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";

const identityDescription = "Identity binding only: the introduced local entity denotes this canonical entity itself, not its owner, carrier, container or a distinct part of it. A visible hand is not identical to the whole person merely because it belongs to that person. Use null when the introduced referent has no established canonical counterpart. Existing observer-local identities remain available for the same referent; evidence-supported new appearances and unbound local identities are still allowed.";
export const PERCEPTION_REPORT_DOMAINS = `perception-report-domains-v2@${contentHash(identityDescription).slice(0, 16)}`;
type ObjectValue = Record<string, unknown>;
const sourceShape = z.looseObject({
  task: z.looseObject({ assignment: z.looseObject({ perceptionTargets: z.array(z.looseObject({
    targetIndex: z.number().int().nonnegative(), observerRef: z.string(), sourceActionRef: z.string(),
  })) }) }),
  referenceCatalog: z.looseObject({ candidates: z.array(z.looseObject({
    handle: z.string(), kind: z.string(), allowedUses: z.array(z.string()), statePath: z.string().optional(),
  })) }),
  state: z.looseObject({
    canonicalTruth: z.looseObject({ entities: z.record(z.string(), z.unknown()), facts: z.record(z.string(), z.unknown()) }),
    world: z.looseObject({ laws: z.array(z.looseObject({ id: z.string() })) }),
    actors: z.array(z.looseObject({ availableLocalEntityRefs: z.array(z.string()) })),
    committedCheckRequests: z.array(z.looseObject({ checkRef: z.string(), actorRef: z.string(), phase: z.string(), stakes: z.string(),
      causes: z.array(z.looseObject({ kind: z.string(), ref: z.string() })),
    })),
    checkResults: z.array(z.looseObject({ checkRef: z.string(), succeeded: z.boolean() })),
  }),
});
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("perception report schema shape changed");
  return value as ObjectValue;
}
function objects(value: unknown): ObjectValue[] {
  if (!Array.isArray(value)) throw new ModelConfigurationError("perception report schema union changed");
  return value.map(object);
}

/** Complete field domains, without selecting an observer, event or semantic result. */
export function perceptionReportDomainsSchema(context: unknown): Record<string, unknown> {
  const { state, referenceCatalog: { candidates }, task: { assignment: { perceptionTargets } } } = sourceShape.parse(context);
  const byHandle = new Map(candidates.map(candidate => [candidate.handle, candidate]));
  if (byHandle.size !== candidates.length || candidates.some(row => !row.handle.startsWith(`ref:${row.kind}:`))) {
    throw new ModelConfigurationError("perception report domains have duplicate or mismatched handles");
  }
  const requireMembers = (kind: string, handles: readonly string[]) => {
    const supplied = candidates.filter(row => row.kind === kind).map(row => row.handle);
    if (new Set(handles).size !== supplied.length || handles.some(handle => byHandle.get(handle)?.kind !== kind)) {
      throw new ModelConfigurationError(`perception report ${kind} domain has incomplete source membership`);
    }
  };
  requireMembers("entity", Object.keys(state.canonicalTruth.entities));
  requireMembers("fact", Object.keys(state.canonicalTruth.facts));
  requireMembers("check", state.committedCheckRequests.map(check => check.checkRef));
  const results = new Map(state.checkResults.map(check => [check.checkRef, check]));
  if (results.size !== state.checkResults.length || results.size !== state.committedCheckRequests.length ||
    state.committedCheckRequests.some(check => !results.has(check.checkRef))) {
    throw new ModelConfigurationError("perception report has incomplete committed check results");
  }
  const assignments = new Set<string>(), targetIndices = new Set<number>();
  for (const target of perceptionTargets) {
    const pair = JSON.stringify([target.observerRef, target.sourceActionRef]);
    if (targetIndices.has(target.targetIndex) || assignments.has(pair) || byHandle.get(target.observerRef)?.kind !== "entity" ||
      byHandle.get(target.sourceActionRef)?.kind !== "action") throw new ModelConfigurationError("Invalid perception report assignment");
    assignments.add(pair);
    targetIndices.add(target.targetIndex);
  }
  requireMembers("local_entity", state.actors.flatMap(actor => actor.availableLocalEntityRefs));
  if (new Set(state.world.laws.map(law => law.id)).size !== state.world.laws.length ||
    candidates.filter(row => row.kind === "law").length !== state.world.laws.length ||
    state.world.laws.some(law => candidates.filter(row => row.kind === "law" && row.statePath === `state.world.laws.${law.id}`).length !== 1)) {
    throw new ModelConfigurationError("perception report law domain has incomplete source membership");
  }
  const definitions: Record<string, unknown> = {};
  const domainNames = new Map<string, string>();
  const bind = (reference: unknown, kind: string, use: string) => {
    const node = object(reference);
    const string = node.anyOf ? objects(node.anyOf).find(option => option.type === "string") : node;
    if (!string || string.pattern !== `^ref:${kind}:` || string.enum !== undefined || string.allOf !== undefined) {
      throw new ModelConfigurationError("perception report reference field changed");
    }
    const handles = candidates.filter(row => row.kind === kind && row.allowedUses.includes(use)).map(row => row.handle);
    const key = `${kind}:${contentHash(handles)}`;
    let name = domainNames.get(key);
    if (!name) {
      name = `perception_${kind}_${use}`;
      definitions[name] = handles.length ? { type: "string", enum: handles } : { not: {} };
      domainNames.set(key, name);
    }
    string.allOf = [{ $ref: `#/$defs/${name}` }];
  };
  const schema = z.toJSONSchema(perceptionDirectiveSchema, { target: "draft-07" });
  const terminal = objects(schema.oneOf).find(option => object(object(option.properties).kind).const === "done")!;
  const reports = objects(object(object(object(terminal.properties).reports).items).oneOf);
  for (const report of reports) {
    const fields = object(report.properties);
    const perceived = object(fields.kind).const === "perceived";
    report.allOf = [perceptionTargets.length ? { anyOf: perceptionTargets.map(target => {
      const assigned = state.committedCheckRequests.filter(check => check.phase === "perception" && check.actorRef === target.observerRef &&
        check.causes.some(cause => cause.kind === "action" && cause.ref === target.sourceActionRef));
      const usable = assigned.filter(check => check.causes.some(cause => cause.kind === "fact" || cause.kind === "law") &&
        (!perceived || results.get(check.checkRef)!.succeeded));
      return { properties: {
        targetIndex: { const: target.targetIndex, description: JSON.stringify({
          observerRef: target.observerRef, sourceActionRef: target.sourceActionRef,
          committedChecks: assigned.map(check => ({ checkRef: check.checkRef, stakes: check.stakes,
            succeeded: results.get(check.checkRef)!.succeeded })),
        }) },
        checkRefs: { uniqueItems: true, items: usable.length ? { enum: usable.map(check => check.checkRef) } : { not: {} },
          ...(perceived && assigned.length ? { minItems: 1 } : {}) },
      } };
    }) } : { not: {} }];
    for (const evidence of objects(object(object(fields.evidence).items).oneOf)) {
      const properties = object(evidence.properties);
      bind(properties.ref, String(object(properties.kind).const), "assertion");
    }
    bind(object(fields.checkRefs).items, "check", "assertion");
    if (!fields.stimulus) continue;
    const stimulus = object(object(fields.stimulus).properties);
    const introduction = object(object(object(stimulus.introductions).items).properties);
    bind(introduction.canonicalEntityRef, "entity", "target");
    object(introduction.canonicalEntityRef).description = identityDescription;
    const claim = object(object(object(stimulus.apparentClaims).items).properties);
    bind(claim.subjectRef, "local_entity", "target");
    const localValue = objects(object(claim.value).oneOf).find(option => object(object(option.properties).kind).const === "local_entity")!;
    bind(object(localValue.properties).entityRef, "local_entity", "target");
  }
  const reportArray = object(object(terminal.properties).reports);
  reportArray.minItems = perceptionTargets.length;
  reportArray.maxItems = perceptionTargets.length;
  if (perceptionTargets.length) reportArray.allOf = perceptionTargets.map(target => ({ contains: {
    type: "object", properties: { targetIndex: { const: target.targetIndex } }, required: ["targetIndex"],
  } }));
  return { ...schema, $defs: definitions };
}

export function perceptionReportDomainsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  if (request.wireJsonSchema || request.preprocessOutput || request.jsonExamplePolicy !== undefined ||
    request.promptVersion.includes(PERCEPTION_REPORT_DOMAINS) ||
    contentHash(z.toJSONSchema(request.schema, { target: "draft-07" })) !== contentHash(z.toJSONSchema(perceptionDirectiveSchema, { target: "draft-07" }))) {
    throw new ModelConfigurationError("perception report domains require the unmodified canonical output contract");
  }
  return { ...request, promptVersion: `${request.promptVersion}/${PERCEPTION_REPORT_DOMAINS}`,
    wireJsonSchema: perceptionReportDomainsSchema(request.context) };
}

/** The check example and every byte outside the schema must remain unchanged. */
export function verifyOnlyPerceptionReportDomainsChanged(baseline: unknown, treatment: unknown, context: unknown): void {
  const body = z.looseObject({ messages: z.array(z.looseObject({ role: z.string(), content: z.string() })) });
  const expected = structuredClone(body.parse(baseline));
  const messages = expected.messages.filter(message => message.role === "user");
  const original = JSON.stringify(z.toJSONSchema(perceptionDirectiveSchema, { target: "draft-07" }));
  if (messages.length !== 1 || messages[0]!.content.split(original).length !== 2) {
    throw new ModelConfigurationError("perception report comparison requires one original schema occurrence");
  }
  messages[0]!.content = messages[0]!.content.replace(original, JSON.stringify(perceptionReportDomainsSchema(context)));
  if (contentHash(expected) !== contentHash(body.parse(treatment))) {
    throw new ModelConfigurationError("perception report treatment changed more than its field schema");
  }
}
