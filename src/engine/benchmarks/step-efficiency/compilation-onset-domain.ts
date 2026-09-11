import { z } from "zod";
import type { SimulationState } from "../../contracts/model";
import { actionGroundingReferenceResolver } from "../../mechanics/action-dependency";
import { evaluateCausalAssertion } from "../../mechanics/causality";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (reason: string): never => { throw new ModelConfigurationError(`compilation onset domain: ${reason}`); };
const record = (value: unknown): Value => object(value) ? value : fail("expected source object");
const removedKinds = ["fact_absent", "entity_absent"] as const;
const instruction = loadPromptAsset("shared/compilation-onset-domain.md");
export const COMPILATION_ONSET_DOMAIN = `at-existing-record-onset-v1@${contentHash({ instruction, removedKinds }).slice(0, 16)}`;

/** The compiler issues Fact/Entity selectors from current records only. Check
 * its complete resolver superset, including records omitted by retrieval. */
export function compilationOnsetDomainProof(state: Readonly<SimulationState>) {
  const stateHash = contentHash(state), resolver = actionGroundingReferenceResolver(state);
  const records = resolver.candidatesFor("assertion").flatMap(row => {
    if (row.kind !== "fact" && row.kind !== "entity") return [];
    const bound = resolver.resolve(row.handle, "assertion");
    const assertion = bound.kind === "fact"
      ? { kind: "fact_absent" as const, factId: bound.engineId }
      : { kind: "entity_absent" as const, entityId: bound.engineId };
    if (evaluateCausalAssertion(state, assertion).passed) return fail("absence branch has an inhabited source domain");
    return [{ handle: row.handle, kind: row.kind }];
  });
  if (contentHash(state) !== stateHash) return fail("resolver mutated source");
  return { stateHash, resolverHash: contentHash(records),
    facts: records.filter(row => row.kind === "fact").length,
    entities: records.filter(row => row.kind === "entity").length };
}

/** Specialize only onset assertion unions, never arbitrary nested JSON or
 * Truth-resolution postconditions. Every other schema predicate is retained. */
export function specializeCompilationOnsetSchema(source: Value): Value {
  const schema = structuredClone(source);
  const slots = record(record(record(schema.properties).slots).items);
  const plans = record(record(slots.properties).temporalPlan).oneOf;
  if (!Array.isArray(plans) || !plans.length) return fail("missing temporal branches");
  const specialize = (node: Value): Value => {
    const branches = node.oneOf;
    if (!Array.isArray(branches)) return fail("missing assertion union");
    const kinds = branches.map(branch => record(record(record(branch).properties).kind).const);
    if (removedKinds.some(kind => kinds.filter(value => value === kind).length !== 1)) return fail("assertion contract drift");
    return { ...node, oneOf: branches.filter((_, index) => !(removedKinds as readonly unknown[]).includes(kinds[index])) };
  };
  for (const plan of plans) {
    const assertions = record(record(record(plan).properties).continuationAssertions);
    if (assertions.type === "array") assertions.items = specialize(record(assertions.items));
    else if (assertions.type === "object") {
      const properties = record(assertions.properties), rest = record(properties.rest);
      properties.first = specialize(record(properties.first));
      rest.items = specialize(record(rest.items));
    } else return fail("unsupported onset assertion shape");
  }
  return schema;
}

/** Called only around the actual AT compiler with its unchanged source state.
 * The wire schema guides generation; the original schema and onset evaluator
 * still reject any false assertion returned despite that guidance. */
export function compilationOnsetDomainRequest<T>(request: StructuredModelRequest<T>, state: Readonly<SimulationState>): StructuredModelRequest<T> {
  if (request.role !== "action-compilation" || request.schemaName !== "action_compilation_at_eligible_source_choice_v1") return request;
  if (request.promptVersion.includes(COMPILATION_ONSET_DOMAIN)) return fail("already applied");
  const context = record(request.context), execution = record(context.execution);
  if (context.contractVersion !== 17 || execution.revision !== state.revision || execution.step !== state.step ||
    execution.worldId !== state.worldId) return fail("source epoch or projector contract differs");
  const proof = compilationOnsetDomainProof(state), contextHash = contentHash(request.context);
  const wireJsonSchema = specializeCompilationOnsetSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  return { ...request, wireJsonSchema, system: [request.system, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${COMPILATION_ONSET_DOMAIN}@${contentHash(proof).slice(0, 16)}`,
    preprocessOutput: raw => {
      if (contentHash(state) !== proof.stateHash || contentHash(request.context) !== contextHash) return fail("source binding changed");
      return request.preprocessOutput?.(raw) ?? { value: raw, symbolRepairs: [] };
    } };
}
